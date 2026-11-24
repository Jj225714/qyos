package service

// 企业OS（SSO-20261115-05）：OIDC 企业绑定模式。
//
// 在 oidc_connect.enterprise_binding_prefix 非空时，OIDC 登录只能进入备注中写有
// "os-bridge casdoor:<sub>" 的 JAPI 账号——这个绑定只由 os-bridge（部门、在职、管理员检查之后）
// 或管理员手工写入。此模式从不新建账号、从不按邮箱认领账号、从不登录管理员账号。

import (
	"context"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/authidentity"
	dbuser "github.com/Wei-Shaw/sub2api/ent/user"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var (
	ErrEnterpriseOIDCNotProvisioned   = infraerrors.Forbidden("ENTERPRISE_ACCOUNT_NOT_PROVISIONED", "no enterprise-provisioned account for this identity; sign in through the enterprise portal first")
	ErrEnterpriseOIDCBindingMismatch  = infraerrors.Forbidden("ENTERPRISE_BINDING_MISMATCH", "this account is not bound to the signed-in enterprise identity")
	ErrEnterpriseOIDCAdminRefused     = infraerrors.Forbidden("ENTERPRISE_ADMIN_REFUSED", "administrator accounts cannot sign in through enterprise OIDC")
	ErrEnterpriseOIDCIdentityConflict = infraerrors.Forbidden("AUTH_IDENTITY_CONFLICT", "this enterprise identity is linked to a different account")
	ErrEnterpriseOIDCPendingDisabled  = infraerrors.Forbidden("ENTERPRISE_OIDC_PENDING_DISABLED", "pending OIDC sign-up and binding flows are disabled in enterprise mode")
)

var enterpriseOIDCAllowedAlgs = map[string]bool{"RS256": true, "ES256": true, "PS256": true}

// EnterpriseOIDCConfigError checks the EFFECTIVE OIDC configuration (after admin-setting overrides) against the
// enterprise contract. nil when the prefix is unset (upstream behaviour) or the configuration is acceptable.
func EnterpriseOIDCConfigError(cfg config.OIDCConnectConfig) error {
	prefix := strings.TrimSpace(cfg.EnterpriseBindingPrefix)
	if prefix == "" {
		return nil
	}
	fail := func(reason string) error {
		return infraerrors.ServiceUnavailable("ENTERPRISE_OIDC_MISCONFIGURED", "enterprise OIDC misconfigured: "+reason)
	}
	if prefix != config.EnterpriseBindingPrefixOSBridge {
		return fail("enterprise_binding_prefix")
	}
	if !cfg.Enabled {
		return fail("oidc disabled")
	}
	if strings.TrimSpace(cfg.ClientID) == "" || strings.TrimSpace(cfg.RedirectURL) == "" {
		return fail("client_id/redirect_url")
	}
	if !cfg.UsePKCE {
		return fail("use_pkce")
	}
	if !cfg.ValidateIDToken {
		return fail("validate_id_token")
	}
	issuer, ok := enterpriseTrustedURL(cfg.IssuerURL)
	if !ok {
		return fail("issuer_url")
	}
	jwks, ok := enterpriseTrustedURL(cfg.JWKSURL)
	if !ok || !strings.EqualFold(jwks.Host, issuer.Host) || jwks.Scheme != issuer.Scheme {
		return fail("jwks_url")
	}
	algs := strings.Split(strings.TrimSpace(cfg.AllowedSigningAlgs), ",")
	count := 0
	for _, alg := range algs {
		alg = strings.ToUpper(strings.TrimSpace(alg))
		if alg == "" {
			continue
		}
		if !enterpriseOIDCAllowedAlgs[alg] {
			return fail("allowed_signing_algs")
		}
		count++
	}
	if count == 0 {
		return fail("allowed_signing_algs")
	}
	// Confidential client only: an authenticated token method AND the secret that method needs.
	switch strings.ToLower(strings.TrimSpace(cfg.TokenAuthMethod)) {
	case "", "client_secret_post", "client_secret_basic":
		if strings.TrimSpace(cfg.ClientSecret) == "" {
			return fail("client_secret")
		}
	default:
		return fail("token_auth_method")
	}
	return nil
}

// enterpriseTrustedURL accepts https URLs; plain http only for loopback hosts (local tests).
func enterpriseTrustedURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil {
		return nil, false
	}
	switch u.Scheme {
	case "https":
		return u, true
	case "http":
		host := u.Hostname()
		if host == "localhost" {
			return u, true
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return u, true
		}
	}
	return nil, false
}

// BindingSubject returns the Casdoor subject bound in a JAPI account's notes ("<prefix><sub>"), or "".
// Same semantics as os-bridge bindingOf: the prefix starts the notes or follows whitespace.
func BindingSubject(notes, prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		return ""
	}
	re := regexp.MustCompile(`(?:^|\s)` + regexp.QuoteMeta(prefix) + `(\S+)`)
	m := re.FindStringSubmatch(notes)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// EnterpriseOIDCLoginInput is the already-validated upstream identity (ID token checked by the caller).
type EnterpriseOIDCLoginInput struct {
	Prefix           string
	ProviderKey      string // issuer
	ProviderSubject  string // id_token sub
	Email            string // upstream email (lookup hint only; never trusted for linking)
	Username         string
	DisplayName      string
	AvatarURL        string
	UpstreamMetadata map[string]any
}

// ResolveEnterpriseBoundOIDCUser finds the account an enterprise OIDC identity may use. Read-only.
func (s *AuthService) ResolveEnterpriseBoundOIDCUser(ctx context.Context, in EnterpriseOIDCLoginInput) (*User, error) {
	if s == nil || s.userRepo == nil || s.entClient == nil {
		return nil, ErrServiceUnavailable
	}
	issuer := strings.TrimSpace(in.ProviderKey)
	subject := strings.TrimSpace(in.ProviderSubject)
	if issuer == "" || subject == "" {
		return nil, ErrEnterpriseOIDCNotProvisioned
	}
	identityUser, err := s.findEmailOAuthIdentityOwner(ctx, "oidc", issuer, subject)
	if err != nil {
		return nil, err
	}
	var emailUser *User
	if email := strings.TrimSpace(strings.ToLower(in.Email)); email != "" {
		emailUser, err = s.userRepo.GetByEmail(ctx, email)
		if err != nil {
			if !errors.Is(err, ErrUserNotFound) {
				return nil, ErrServiceUnavailable
			}
			emailUser = nil
		}
	}
	if identityUser != nil && emailUser != nil && identityUser.ID != emailUser.ID {
		return nil, ErrEnterpriseOIDCIdentityConflict
	}
	candidate := identityUser
	if candidate == nil {
		candidate = emailUser
	}
	if candidate == nil {
		return nil, ErrEnterpriseOIDCNotProvisioned
	}
	if err := enterpriseAccountError(candidate.Notes, candidate.Role, candidate.Status, in.Prefix, subject); err != nil {
		return nil, err
	}
	return candidate, nil
}

// enterpriseAccountError applies the binding/admin/active rules to one account state.
func enterpriseAccountError(notes, role, status, prefix, subject string) error {
	if BindingSubject(notes, prefix) != subject {
		return ErrEnterpriseOIDCBindingMismatch
	}
	if role == RoleAdmin {
		return ErrEnterpriseOIDCAdminRefused
	}
	if status != StatusActive {
		return ErrUserNotActive
	}
	return nil
}

// errEnterpriseOIDCRetry marks a transaction that lost a race (account row changed, identity row inserted
// concurrently); the whole check-and-write is repeated once from fresh reads.
var errEnterpriseOIDCRetry = errors.New("enterprise oidc: concurrent change, retry")

// CompleteEnterpriseBoundOIDCLogin re-validates the account and links the identity in ONE transaction, then
// issues tokens from a fresh post-commit read. The resolved user is only a hint for its ID: binding, role and
// status are re-read inside the transaction and guarded by a compare-and-set on the account row, so a
// binding removal, replacement, deactivation or promotion committed after resolution refuses the login and
// writes nothing. An identity row owned by another account is never moved.
func (s *AuthService) CompleteEnterpriseBoundOIDCLogin(ctx context.Context, resolved *User, in EnterpriseOIDCLoginInput) (*TokenPair, error) {
	if s == nil || s.entClient == nil || s.userRepo == nil || resolved == nil {
		return nil, ErrServiceUnavailable
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = s.bindEnterpriseOIDCIdentity(ctx, resolved.ID, in); !errors.Is(err, errEnterpriseOIDCRetry) {
			break
		}
	}
	if errors.Is(err, errEnterpriseOIDCRetry) {
		return nil, ErrServiceUnavailable
	}
	if err != nil {
		return nil, err
	}
	user, err := s.userRepo.GetByID(ctx, resolved.ID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return nil, ErrEnterpriseOIDCNotProvisioned
		}
		return nil, ErrServiceUnavailable
	}
	// Tokens are generated only from the current account state.
	if err := enterpriseAccountError(user.Notes, user.Role, user.Status, in.Prefix, strings.TrimSpace(in.ProviderSubject)); err != nil {
		return nil, err
	}
	s.RecordSuccessfulLogin(ctx, user.ID)
	return s.GenerateTokenPair(ctx, user, "")
}

func (s *AuthService) bindEnterpriseOIDCIdentity(ctx context.Context, userID int64, in EnterpriseOIDCLoginInput) (err error) {
	providerKey := strings.TrimSpace(in.ProviderKey)
	subject := strings.TrimSpace(in.ProviderSubject)
	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return ErrServiceUnavailable
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	account, err := tx.User.Get(ctx, userID)
	if err != nil {
		if dbent.IsNotFound(err) {
			return ErrEnterpriseOIDCNotProvisioned
		}
		return ErrServiceUnavailable
	}
	if err := enterpriseAccountError(account.Notes, account.Role, account.Status, in.Prefix, subject); err != nil {
		return err
	}
	// Compare-and-set: succeeds only while notes/role/status are exactly what was just checked. On PostgreSQL
	// the UPDATE takes the row lock and re-evaluates the WHERE clause against concurrently committed changes.
	// updated_at is written back unchanged, so the account is not otherwise modified.
	n, err := tx.User.Update().
		Where(dbuser.IDEQ(userID), dbuser.NotesEQ(account.Notes), dbuser.RoleEQ(account.Role), dbuser.StatusEQ(account.Status)).
		SetNotes(account.Notes).
		SetUpdatedAt(account.UpdatedAt).
		Save(ctx)
	if err != nil {
		return ErrServiceUnavailable
	}
	if n != 1 {
		return errEnterpriseOIDCRetry
	}
	metadata := map[string]any{"email": strings.ToLower(strings.TrimSpace(account.Email)), "email_verified": true}
	for key, value := range in.UpstreamMetadata {
		metadata[key] = value
	}
	for key, value := range map[string]string{"username": in.Username, "display_name": in.DisplayName, "avatar_url": in.AvatarURL} {
		if strings.TrimSpace(value) != "" {
			metadata[key] = strings.TrimSpace(value)
		}
	}
	row, err := tx.AuthIdentity.Query().Where(
		authidentity.ProviderTypeEQ("oidc"),
		authidentity.ProviderKeyEQ(providerKey),
		authidentity.ProviderSubjectEQ(subject),
	).Only(ctx)
	switch {
	case err == nil:
		if row.UserID != userID {
			return ErrEnterpriseOIDCIdentityConflict
		}
		if _, err := tx.AuthIdentity.UpdateOneID(row.ID).SetMetadata(metadata).Save(ctx); err != nil {
			return ErrServiceUnavailable
		}
	case dbent.IsNotFound(err):
		if _, err := tx.AuthIdentity.Create().
			SetUserID(userID).
			SetProviderType("oidc").
			SetProviderKey(providerKey).
			SetProviderSubject(subject).
			SetMetadata(metadata).
			Save(ctx); err != nil {
			if dbent.IsConstraintError(err) {
				return errEnterpriseOIDCRetry // a concurrent first login inserted the row: re-check its owner
			}
			return ErrServiceUnavailable
		}
	default:
		return ErrServiceUnavailable
	}
	if err := tx.Commit(); err != nil {
		if dbent.IsConstraintError(err) {
			return errEnterpriseOIDCRetry
		}
		return ErrServiceUnavailable
	}
	committed = true
	return nil
}
