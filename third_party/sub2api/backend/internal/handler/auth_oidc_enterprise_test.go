package handler

// 企业OS（SSO-20261115-05）：OIDC 企业绑定模式测试（模拟 IdP，不是真实环境验收）。

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/authidentity"
	"github.com/Wei-Shaw/sub2api/ent/pendingauthsession"
	dbuser "github.com/Wei-Shaw/sub2api/ent/user"
	"github.com/Wei-Shaw/sub2api/internal/config"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
)

const enterprisePrefix = config.EnterpriseBindingPrefixOSBridge

type enterpriseProvider struct {
	cfg           config.OIDCConnectConfig
	tokenRequests atomic.Int32
	key           *rsa.PrivateKey
	close         func()
}

type enterpriseFixture struct {
	Subject string
	Email   string
	// Mutate adjusts the ID-token claims; WrongKey signs with an unrelated key.
	Mutate   func(*oidcIDTokenClaims)
	WrongKey bool
}

// newEnterpriseOIDCProvider is a fake IdP (token, userinfo, JWKS) whose ID token carries nonce "nonce-<sub>".
func newEnterpriseOIDCProvider(t *testing.T, fixture enterpriseFixture) *enterpriseProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	signingKey := key
	if fixture.WrongKey {
		signingKey, err = rsa.GenerateKey(rand.Reader, 2048)
		require.NoError(t, err)
	}
	p := &enterpriseProvider{key: key}
	jwks := oidcJWKSet{Keys: []oidcJWK{buildRSAJWK("ent-kid", &key.PublicKey)}}
	var issuer string
	var idToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			p.tokenRequests.Add(1)
			_ = json.NewEncoder(w).Encode(oidcTokenResponse{AccessToken: "ent-access", TokenType: "Bearer", ExpiresIn: 3600, IDToken: idToken})
		case "/userinfo":
			_ = json.NewEncoder(w).Encode(map[string]any{"sub": fixture.Subject, "preferred_username": "emp", "name": "Employee", "email": fixture.Email, "email_verified": true})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(jwks)
		default:
			http.NotFound(w, r)
		}
	}))
	issuer = server.URL
	now := time.Now()
	claims := oidcIDTokenClaims{
		Email:         fixture.Email,
		EmailVerified: boolPtr(true),
		Name:          "Employee",
		Nonce:         "nonce-" + fixture.Subject,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   fixture.Subject,
			Audience:  jwt.ClaimStrings{"ent-client"},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-30 * time.Second)),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	if fixture.Mutate != nil {
		fixture.Mutate(&claims)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "ent-kid"
	idToken, err = token.SignedString(signingKey)
	require.NoError(t, err)
	p.cfg = config.OIDCConnectConfig{
		Enabled:                 true,
		ProviderName:            "企业账号",
		ClientID:                "ent-client",
		ClientSecret:            "ent-secret",
		IssuerURL:               issuer,
		AuthorizeURL:            issuer + "/authorize",
		TokenURL:                issuer + "/token",
		UserInfoURL:             issuer + "/userinfo",
		JWKSURL:                 issuer + "/jwks",
		Scopes:                  "openid profile email",
		RedirectURL:             "https://japi.example.com/api/v1/auth/oauth/oidc/callback",
		FrontendRedirectURL:     "/auth/oidc/callback",
		TokenAuthMethod:         "client_secret_post",
		UsePKCE:                 true,
		ValidateIDToken:         true,
		AllowedSigningAlgs:      "RS256",
		ClockSkewSeconds:        120,
		EnterpriseBindingPrefix: enterprisePrefix,
	}
	p.close = server.Close
	t.Cleanup(server.Close)
	return p
}

func enterpriseHandler(t *testing.T, cfg config.OIDCConnectConfig, overrides map[string]string) (*AuthHandler, *dbent.Client) {
	t.Helper()
	handler, client := newOIDCOAuthHandlerAndClientWithSettings(t, false, cfg, overrides)
	t.Cleanup(func() { _ = client.Close() })
	return handler, client
}

type callbackOptions struct {
	state, cookieState, nonce, intent string
	noBrowserCookie                   bool
}

func runEnterpriseCallback(t *testing.T, handler *AuthHandler, subject string, opts callbackOptions) *httptest.ResponseRecorder {
	t.Helper()
	state := firstNonEmpty(opts.state, "ent-state")
	cookieState := firstNonEmpty(opts.cookieState, state)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/oidc/callback?code=ent-code&state="+state, nil)
	req.AddCookie(encodedCookie(oidcOAuthStateCookieName, cookieState))
	req.AddCookie(encodedCookie(oidcOAuthRedirectCookie, "/dashboard"))
	req.AddCookie(encodedCookie(oidcOAuthVerifierCookie, "ent-verifier"))
	req.AddCookie(encodedCookie(oidcOAuthNonceCookie, firstNonEmpty(opts.nonce, "nonce-"+subject)))
	req.AddCookie(encodedCookie(oidcOAuthIntentCookieName, firstNonEmpty(opts.intent, oauthIntentLogin)))
	if !opts.noBrowserCookie {
		req.AddCookie(encodedCookie(oauthPendingBrowserCookieName, "ent-browser"))
	}
	c.Request = req
	handler.OIDCOAuthCallback(c)
	return recorder
}

func createEnterpriseUser(t *testing.T, client *dbent.Client, email, notes, role, status string) *dbent.User {
	t.Helper()
	user, err := client.User.Create().
		SetEmail(email).
		SetUsername(strings.Split(email, "@")[0]).
		SetPasswordHash("hash").
		SetRole(role).
		SetStatus(status).
		SetNotes(notes).
		Save(context.Background())
	require.NoError(t, err)
	return user
}

func countIdentities(t *testing.T, client *dbent.Client, subject string) int {
	t.Helper()
	n, err := client.AuthIdentity.Query().Where(authidentity.ProviderSubjectEQ(subject)).Count(context.Background())
	require.NoError(t, err)
	return n
}

func countUsers(t *testing.T, client *dbent.Client) int {
	t.Helper()
	n, err := client.User.Query().Count(context.Background())
	require.NoError(t, err)
	return n
}

func requireEnterpriseRefused(t *testing.T, recorder *httptest.ResponseRecorder, code string) {
	t.Helper()
	require.Equal(t, http.StatusFound, recorder.Code)
	location := recorder.Header().Get("Location")
	require.NotContains(t, location, "access_token=")
	require.NotContains(t, location, "refresh_token=")
	require.Equal(t, code, parseOAuthRedirectFragment(t, location).Get("error"))
}

// T-J1: a bound employee signs in; the identity row is created once and reused.
func TestEnterpriseOIDCBoundEmployeeSignsIn(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj1", Email: "tj1@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	user := createEnterpriseUser(t, client, "tj1@acme.example", "legacy note os-bridge casdoor:cas-tj1", service.RoleUser, service.StatusActive)

	recorder := runEnterpriseCallback(t, handler, "cas-tj1", callbackOptions{})
	require.Equal(t, http.StatusFound, recorder.Code)
	location := recorder.Header().Get("Location")
	require.Contains(t, location, "/auth/oidc/callback#")
	values := parseOAuthRedirectFragment(t, location)
	require.NotEmpty(t, values.Get("access_token"))
	require.NotEmpty(t, values.Get("refresh_token"))
	require.Equal(t, "/dashboard", values.Get("redirect"))
	requireCookieCleared(t, recorder, oauthPendingSessionCookieName)
	requireCookieCleared(t, recorder, oauthPendingBrowserCookieName)

	claims, err := handler.authService.ValidateToken(values.Get("access_token"))
	require.NoError(t, err)
	require.Equal(t, user.ID, claims.UserID)
	require.Equal(t, service.RoleUser, claims.Role)

	identity, err := client.AuthIdentity.Query().Where(authidentity.ProviderSubjectEQ("cas-tj1")).Only(context.Background())
	require.NoError(t, err)
	require.Equal(t, user.ID, identity.UserID)
	require.Equal(t, p.cfg.IssuerURL, identity.ProviderKey)

	// Second login reuses the row.
	again := runEnterpriseCallback(t, handler, "cas-tj1", callbackOptions{})
	require.Contains(t, again.Header().Get("Location"), "access_token=")
	require.Equal(t, 1, countIdentities(t, client, "cas-tj1"))
	pending, err := client.PendingAuthSession.Query().Where(pendingauthsession.ProviderSubjectEQ("cas-tj1")).Count(context.Background())
	require.NoError(t, err)
	require.Zero(t, pending, "enterprise mode never creates pending sessions")
}

// T-J2/T-J3/T-J4/T-J5: unbound, bound to another subject, admin, disabled → refused, nothing written.
func TestEnterpriseOIDCRefusesUnboundOtherAdminAndDisabled(t *testing.T) {
	cases := []struct {
		name, subject, email, notes, role, status, code string
	}{
		{"unbound same email", "cas-tj2", "tj2@acme.example", "legacy", service.RoleUser, service.StatusActive, "enterprise_binding_mismatch"},
		{"bound to another subject", "cas-tj3", "tj3@acme.example", "os-bridge casdoor:cas-someone-else", service.RoleUser, service.StatusActive, "enterprise_binding_mismatch"},
		{"embedded prefix is not a binding", "cas-tj3b", "tj3b@acme.example", "xos-bridge casdoor:cas-tj3b", service.RoleUser, service.StatusActive, "enterprise_binding_mismatch"},
		{"admin with matching binding", "cas-tj4", "tj4@acme.example", "os-bridge casdoor:cas-tj4", service.RoleAdmin, service.StatusActive, "enterprise_admin_refused"},
		{"disabled", "cas-tj5", "tj5@acme.example", "os-bridge casdoor:cas-tj5 [os-bridge-disabled]", service.RoleUser, service.StatusDisabled, "login_blocked"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: tc.subject, Email: tc.email})
			handler, client := enterpriseHandler(t, p.cfg, nil)
			user := createEnterpriseUser(t, client, tc.email, tc.notes, tc.role, tc.status)
			users := countUsers(t, client)
			requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, tc.subject, callbackOptions{}), tc.code)
			require.Equal(t, users, countUsers(t, client))
			require.Zero(t, countIdentities(t, client, tc.subject))
			after, err := client.User.Get(context.Background(), user.ID)
			require.NoError(t, err)
			require.Equal(t, tc.role, after.Role, "role never changes")
		})
	}
}

// T-J6: no account at all, registration ENABLED → still no account created.
func TestEnterpriseOIDCNeverRegisters(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj6", Email: "tj6@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, map[string]string{service.SettingKeyRegistrationEnabled: "true"})
	users := countUsers(t, client)
	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj6", callbackOptions{}), "enterprise_account_not_provisioned")
	require.Equal(t, users, countUsers(t, client))
	n, err := client.User.Query().Where(dbuser.EmailEQ("tj6@acme.example")).Count(context.Background())
	require.NoError(t, err)
	require.Zero(t, n)
	require.Zero(t, countIdentities(t, client, "cas-tj6"))
}

// T-J7: an identity row whose account lost its binding note no longer signs in (revocation by note removal).
func TestEnterpriseOIDCRevokedBindingRefusesExistingIdentity(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj7", Email: "tj7@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	user := createEnterpriseUser(t, client, "tj7@acme.example", "os-bridge casdoor:cas-tj7", service.RoleUser, service.StatusActive)
	require.Contains(t, runEnterpriseCallback(t, handler, "cas-tj7", callbackOptions{}).Header().Get("Location"), "access_token=")
	_, err := client.User.UpdateOneID(user.ID).SetNotes("binding removed by admin").Save(context.Background())
	require.NoError(t, err)
	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj7", callbackOptions{}), "enterprise_binding_mismatch")
}

// T-J8: issuer in the token differs from the configured issuer (the upstream ID-token check refuses first).
func TestEnterpriseOIDCIssuerMismatch(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj8", Email: "tj8@acme.example", Mutate: func(c *oidcIDTokenClaims) { c.Issuer = "https://evil.example" }})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	createEnterpriseUser(t, client, "tj8@acme.example", "os-bridge casdoor:cas-tj8", service.RoleUser, service.StatusActive)
	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj8", callbackOptions{}), "invalid_id_token")
	require.Zero(t, countIdentities(t, client, "cas-tj8"))
}

// T-J9: bind_current_user is refused at start and at callback.
func TestEnterpriseOIDCBindIntentRefused(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj9", Email: "tj9@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	createEnterpriseUser(t, client, "tj9@acme.example", "os-bridge casdoor:cas-tj9", service.RoleUser, service.StatusActive)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/oidc/start?intent=bind_current_user", nil)
	handler.OIDCOAuthStart(c)
	require.Equal(t, http.StatusForbidden, recorder.Code)
	require.Contains(t, recorder.Body.String(), "ENTERPRISE_BIND_DISABLED")

	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj9", callbackOptions{intent: oauthIntentBindCurrentUser}), "enterprise_bind_disabled")
	require.Zero(t, countIdentities(t, client, "cas-tj9"))
}

func createStalePendingSession(t *testing.T, client *dbent.Client, token, provider string) *dbent.PendingAuthSession {
	t.Helper()
	session, err := client.PendingAuthSession.Create().
		SetSessionToken(token).
		SetIntent("login").
		SetProviderType(provider).
		SetProviderKey("https://issuer.example.com").
		SetProviderSubject("stale-" + token).
		SetResolvedEmail("stale-" + token + "@acme.example").
		SetBrowserSessionKey("stale-browser").
		SetUpstreamIdentityClaims(map[string]any{"username": "stale"}).
		SetLocalFlowState(map[string]any{"completion_response": map[string]any{"step": "choose_account_action"}}).
		SetExpiresAt(time.Now().UTC().Add(10 * time.Minute)).
		Save(context.Background())
	require.NoError(t, err)
	return session
}

// T-J10: every pending route refuses a stored OIDC pending session (including one created before enterprise mode),
// decided by the stored provider; a non-OIDC stored session is not affected by this rule.
func TestEnterpriseOIDCPendingRoutesRefuseStoredOIDCSessions(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj10", Email: "tj10@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	routes := []struct {
		name string
		body string
		call func(*gin.Context)
	}{
		{"complete-registration", `{"invitation_code":"x"}`, handler.CompleteOIDCOAuthRegistration},
		{"create-account (oidc)", `{"email":"new@acme.example","password":"secret123"}`, handler.CreateOIDCOAuthAccount},
		{"create-account (generic, body names another provider)", `{"email":"new@acme.example","password":"secret123","provider":"linuxdo"}`, handler.CreatePendingOAuthAccount},
		{"bind-login (oidc)", `{"email":"tj10@acme.example","password":"whatever"}`, handler.BindOIDCOAuthLogin},
		{"bind-login (generic)", `{"email":"tj10@acme.example","password":"whatever"}`, handler.BindPendingOAuthLogin},
		{"exchange", `{}`, handler.ExchangePendingOAuthCompletion},
		{"linuxdo complete-registration", `{"invitation_code":"x"}`, handler.CompleteLinuxDoOAuthRegistration},
	}
	for i, route := range routes {
		t.Run(route.name, func(t *testing.T) {
			token := "stale-oidc-" + string(rune('a'+i))
			createStalePendingSession(t, client, token, "oidc")
			users := countUsers(t, client)
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oauth/pending/x", bytes.NewBufferString(route.body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: oauthPendingSessionCookieName, Value: encodeCookieValue(token)})
			req.AddCookie(&http.Cookie{Name: oauthPendingBrowserCookieName, Value: encodeCookieValue("stale-browser")})
			c.Request = req
			route.call(c)
			require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), "ENTERPRISE_OIDC_PENDING_DISABLED")
			require.Equal(t, users, countUsers(t, client))
			stored, err := client.PendingAuthSession.Query().Where(pendingauthsession.SessionTokenEQ(token)).Only(context.Background())
			require.NoError(t, err)
			require.NotNil(t, stored.ConsumedAt, "the stale session is consumed")
			require.Zero(t, countIdentities(t, client, "stale-"+token))
		})
	}
	// A stored LinuxDo pending session is not touched by the OIDC enterprise rule.
	createStalePendingSession(t, client, "stale-linuxdo", "linuxdo")
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oauth/pending/exchange", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: oauthPendingSessionCookieName, Value: encodeCookieValue("stale-linuxdo")})
	req.AddCookie(&http.Cookie{Name: oauthPendingBrowserCookieName, Value: encodeCookieValue("stale-browser")})
	c.Request = req
	handler.ExchangePendingOAuthCompletion(c)
	require.NotContains(t, recorder.Body.String(), "ENTERPRISE_OIDC_PENDING_DISABLED")
}

// T-J11: prefix unset → upstream adoption behaviour (choice page for a same-email account) is unchanged.
func TestEnterpriseOIDCPrefixUnsetKeepsUpstreamBehaviour(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj11", Email: "tj11@acme.example"})
	cfg := p.cfg
	cfg.EnterpriseBindingPrefix = ""
	handler, client := enterpriseHandler(t, cfg, nil)
	createEnterpriseUser(t, client, "tj11@acme.example", "os-bridge casdoor:cas-tj11", service.RoleUser, service.StatusActive)
	recorder := runEnterpriseCallback(t, handler, "cas-tj11", callbackOptions{})
	require.Equal(t, http.StatusFound, recorder.Code)
	location := recorder.Header().Get("Location")
	require.NotContains(t, location, "access_token=", "upstream shows the adoption choice instead of logging in")
	pending, err := client.PendingAuthSession.Query().Where(pendingauthsession.ProviderSubjectEQ("cas-tj11")).Count(context.Background())
	require.NoError(t, err)
	require.Equal(t, 1, pending)
}

// T-J13 + T-J18: the issued token is a RoleUser token and AdminOnly refuses it.
func TestEnterpriseOIDCTokenIsNotAdmin(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj13", Email: "tj13@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	user := createEnterpriseUser(t, client, "tj13@acme.example", "os-bridge casdoor:cas-tj13", service.RoleUser, service.StatusActive)
	values := parseOAuthRedirectFragment(t, runEnterpriseCallback(t, handler, "cas-tj13", callbackOptions{}).Header().Get("Location"))
	claims, err := handler.authService.ValidateToken(values.Get("access_token"))
	require.NoError(t, err)
	require.Equal(t, service.RoleUser, claims.Role)

	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set(string(servermiddleware.ContextKeyUserRole), claims.Role); c.Next() })
	engine.GET("/api/v1/admin/users", servermiddleware.AdminOnly(), func(c *gin.Context) { c.String(http.StatusOK, "admin data") })
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/admin/users", nil))
	require.Equal(t, http.StatusForbidden, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "admin data")

	after, err := client.User.Get(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, service.RoleUser, after.Role)
	require.Equal(t, user.Balance, after.Balance)
}

// T-J14 (+ C1): admin settings that weaken the effective configuration make enterprise mode fail closed.
func TestEnterpriseOIDCEffectiveOverridesFailClosed(t *testing.T) {
	cases := map[string]map[string]string{
		"pkce off":                       {service.SettingKeyOIDCConnectUsePKCE: "false"},
		"id token validation off":        {service.SettingKeyOIDCConnectValidateIDToken: "false"},
		"hmac algorithm":                 {service.SettingKeyOIDCConnectAllowedSigningAlgs: "HS256"},
		"public client with secret (C1)": {service.SettingKeyOIDCConnectTokenAuthMethod: "none"},
		"jwks on another host":           {service.SettingKeyOIDCConnectJWKSURL: "https://evil.example/jwks"},
	}
	for name, overrides := range cases {
		t.Run(name, func(t *testing.T) {
			p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj14", Email: "tj14@acme.example"})
			handler, client := enterpriseHandler(t, p.cfg, overrides)
			createEnterpriseUser(t, client, "tj14-"+strings.ReplaceAll(name, " ", "-")+"@acme.example", "os-bridge casdoor:cas-tj14", service.RoleUser, service.StatusActive)

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/oidc/start?redirect=/dashboard", nil)
			handler.OIDCOAuthStart(c)
			require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
			require.Contains(t, recorder.Body.String(), "ENTERPRISE_OIDC_MISCONFIGURED")

			before := p.tokenRequests.Load()
			requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj14", callbackOptions{}), "enterprise_oidc_misconfigured")
			require.Equal(t, before, p.tokenRequests.Load(), "no code exchange happens")
			require.Zero(t, countIdentities(t, client, "cas-tj14"))
		})
	}
}

// T-J15: the identity row belongs to account B while the email/binding resolves to account A → conflict.
func TestEnterpriseOIDCIdentityOwnedByAnotherAccount(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj15", Email: "tj15a@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	createEnterpriseUser(t, client, "tj15a@acme.example", "os-bridge casdoor:cas-tj15", service.RoleUser, service.StatusActive)
	b := createEnterpriseUser(t, client, "tj15b@acme.example", "os-bridge casdoor:cas-tj15", service.RoleUser, service.StatusActive)
	_, err := client.AuthIdentity.Create().SetUserID(b.ID).SetProviderType("oidc").SetProviderKey(p.cfg.IssuerURL).SetProviderSubject("cas-tj15").SetMetadata(map[string]any{}).Save(context.Background())
	require.NoError(t, err)
	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tj15", callbackOptions{}), "enterprise_identity_conflict")
	row, err := client.AuthIdentity.Query().Where(authidentity.ProviderSubjectEQ("cas-tj15")).Only(context.Background())
	require.NoError(t, err)
	require.Equal(t, b.ID, row.UserID, "the row is never moved")
}

// T-J16: interleaving of two first logins (deterministic): another request creates the row between resolve and
// complete. Same account → accepted, one row; another account → conflict, row untouched.
func TestEnterpriseOIDCConcurrentFirstLogin(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tj16", Email: "tj16@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, nil)
	a := createEnterpriseUser(t, client, "tj16@acme.example", "os-bridge casdoor:cas-tj16", service.RoleUser, service.StatusActive)
	ctx := context.Background()
	input := service.EnterpriseOIDCLoginInput{Prefix: enterprisePrefix, ProviderKey: p.cfg.IssuerURL, ProviderSubject: "cas-tj16", Email: "tj16@acme.example"}
	resolved, err := handler.authService.ResolveEnterpriseBoundOIDCUser(ctx, input)
	require.NoError(t, err)
	_, err = client.AuthIdentity.Create().SetUserID(a.ID).SetProviderType("oidc").SetProviderKey(p.cfg.IssuerURL).SetProviderSubject("cas-tj16").SetMetadata(map[string]any{}).Save(ctx)
	require.NoError(t, err)
	pair, err := handler.authService.CompleteEnterpriseBoundOIDCLogin(ctx, resolved, input)
	require.NoError(t, err)
	require.NotEmpty(t, pair.AccessToken)
	require.Equal(t, 1, countIdentities(t, client, "cas-tj16"))

	other := createEnterpriseUser(t, client, "tj16-other@acme.example", "x", service.RoleUser, service.StatusActive)
	input2 := service.EnterpriseOIDCLoginInput{Prefix: enterprisePrefix, ProviderKey: p.cfg.IssuerURL, ProviderSubject: "cas-tj16b", Email: "tj16@acme.example"}
	_, err = client.User.UpdateOneID(a.ID).SetNotes("os-bridge casdoor:cas-tj16b").Save(ctx)
	require.NoError(t, err)
	resolved2, err := handler.authService.ResolveEnterpriseBoundOIDCUser(ctx, input2)
	require.NoError(t, err)
	_, err = client.AuthIdentity.Create().SetUserID(other.ID).SetProviderType("oidc").SetProviderKey(p.cfg.IssuerURL).SetProviderSubject("cas-tj16b").SetMetadata(map[string]any{}).Save(ctx)
	require.NoError(t, err)
	_, err = handler.authService.CompleteEnterpriseBoundOIDCLogin(ctx, resolved2, input2)
	require.Error(t, err)
	require.Contains(t, err.Error(), "AUTH_IDENTITY")
	row, err := client.AuthIdentity.Query().Where(authidentity.ProviderSubjectEQ("cas-tj16b")).Only(ctx)
	require.NoError(t, err)
	require.Equal(t, other.ID, row.UserID)
}

// T-J17: the enterprise branch sits behind the upstream checks: bad nonce, audience, expiry, signature, state.
func TestEnterpriseOIDCUpstreamChecksStillApply(t *testing.T) {
	cases := []struct {
		name    string
		fixture enterpriseFixture
		opts    callbackOptions
		code    string
	}{
		{"wrong nonce", enterpriseFixture{Mutate: func(c *oidcIDTokenClaims) { c.Nonce = "other" }}, callbackOptions{}, "invalid_id_token"},
		{"wrong audience", enterpriseFixture{Mutate: func(c *oidcIDTokenClaims) { c.Audience = jwt.ClaimStrings{"another-client"} }}, callbackOptions{}, "invalid_id_token"},
		{"expired", enterpriseFixture{Mutate: func(c *oidcIDTokenClaims) { c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Hour)) }}, callbackOptions{}, "invalid_id_token"},
		{"bad signature", enterpriseFixture{WrongKey: true}, callbackOptions{}, "invalid_id_token"},
		{"state mismatch", enterpriseFixture{}, callbackOptions{state: "ent-state", cookieState: "other-state"}, "invalid_state"},
		{"missing browser session", enterpriseFixture{}, callbackOptions{noBrowserCookie: true}, "missing_browser_session"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject := "cas-tj17-" + string(rune('a'+i))
			tc.fixture.Subject = subject
			tc.fixture.Email = subject + "@acme.example"
			p := newEnterpriseOIDCProvider(t, tc.fixture)
			handler, client := enterpriseHandler(t, p.cfg, nil)
			createEnterpriseUser(t, client, tc.fixture.Email, "os-bridge casdoor:"+subject, service.RoleUser, service.StatusActive)
			requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, subject, tc.opts), tc.code)
			require.Zero(t, countIdentities(t, client, subject))
		})
	}
}

// T-J5b: backend mode (admin-only) blocks the employee before any identity row is written.
func TestEnterpriseOIDCBackendModeBlocksBeforeWrites(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-tjbm", Email: "tjbm@acme.example"})
	handler, client := enterpriseHandler(t, p.cfg, map[string]string{service.SettingKeyBackendModeEnabled: "true"})
	createEnterpriseUser(t, client, "tjbm@acme.example", "os-bridge casdoor:cas-tjbm", service.RoleUser, service.StatusActive)
	requireEnterpriseRefused(t, runEnterpriseCallback(t, handler, "cas-tjbm", callbackOptions{}), "login_blocked")
	require.Zero(t, countIdentities(t, client, "cas-tjbm"))
}
