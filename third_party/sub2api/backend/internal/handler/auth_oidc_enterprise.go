package handler

// 企业OS（SSO-20261115-05）：OIDC 企业绑定模式的处理器部分。见 service/auth_enterprise_oidc.go。

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/config"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// enterpriseOIDCPrefix is the binding prefix of the effective configuration, falling back to the process
// configuration file (the prefix is file-only; admin settings never set or clear it).
func (h *AuthHandler) enterpriseOIDCPrefix(cfg config.OIDCConnectConfig) string {
	if p := strings.TrimSpace(cfg.EnterpriseBindingPrefix); p != "" {
		return p
	}
	if h != nil && h.cfg != nil {
		return strings.TrimSpace(h.cfg.OIDC.EnterpriseBindingPrefix)
	}
	return ""
}

// enterpriseOIDCConfig resolves the effective configuration and, in enterprise mode, enforces the contract on
// it. prefix == "" means upstream behaviour.
func (h *AuthHandler) enterpriseOIDCConfig(cfg config.OIDCConnectConfig) (config.OIDCConnectConfig, string, error) {
	prefix := h.enterpriseOIDCPrefix(cfg)
	if prefix == "" {
		return cfg, "", nil
	}
	cfg.EnterpriseBindingPrefix = prefix
	return cfg, prefix, service.EnterpriseOIDCConfigError(cfg)
}

// enterpriseOIDCActive reports whether enterprise mode is configured at all (used by pending flows that have
// no OIDC configuration at hand).
func (h *AuthHandler) enterpriseOIDCActive(ctx context.Context) bool {
	if h == nil {
		return false
	}
	if h.cfg != nil && strings.TrimSpace(h.cfg.OIDC.EnterpriseBindingPrefix) != "" {
		return true
	}
	if h.settingSvc != nil {
		if cfg, err := h.settingSvc.GetOIDCConnectOAuthConfig(ctx); err == nil && strings.TrimSpace(cfg.EnterpriseBindingPrefix) != "" {
			return true
		}
	}
	return false
}

// enterprisePendingSessionError refuses (and consumes) a stored OIDC pending session in enterprise mode; the
// decision uses the server-stored provider, never a request parameter. nil when the session may proceed.
func (h *AuthHandler) enterprisePendingSessionError(c *gin.Context, svc *service.AuthPendingIdentityService, session *dbent.PendingAuthSession) error {
	if session == nil || !strings.EqualFold(strings.TrimSpace(session.ProviderType), "oidc") || !h.enterpriseOIDCActive(c.Request.Context()) {
		return nil
	}
	if svc != nil {
		_, _ = svc.ConsumeBrowserSession(c.Request.Context(), session.SessionToken, session.BrowserSessionKey)
	}
	secure := isRequestHTTPS(c)
	clearOAuthPendingSessionCookie(c, secure)
	clearOAuthPendingBrowserCookie(c, secure)
	return service.ErrEnterpriseOIDCPendingDisabled
}

// refuseEnterprisePendingSession writes the refusal; true when the request has been answered.
func (h *AuthHandler) refuseEnterprisePendingSession(c *gin.Context, svc *service.AuthPendingIdentityService, session *dbent.PendingAuthSession) bool {
	if err := h.enterprisePendingSessionError(c, svc, session); err != nil {
		response.ErrorFrom(c, err)
		return true
	}
	return false
}

func normalizeEnterpriseIssuer(raw string) string {
	return strings.TrimRight(strings.ToLower(strings.TrimSpace(raw)), "/")
}

var enterpriseOIDCErrorCodes = map[string]string{
	"ENTERPRISE_ACCOUNT_NOT_PROVISIONED": "enterprise_account_not_provisioned",
	"ENTERPRISE_BINDING_MISMATCH":        "enterprise_binding_mismatch",
	"ENTERPRISE_ADMIN_REFUSED":           "enterprise_admin_refused",
	"AUTH_IDENTITY_CONFLICT":             "enterprise_identity_conflict",
	"USER_NOT_ACTIVE":                    "login_blocked",
	"BACKEND_MODE_ADMIN_ONLY":            "login_blocked",
}

// completeEnterpriseOIDCLogin runs after every upstream check of the callback (state, PKCE verifier, nonce,
// token exchange, ID-token validation, userinfo/sub consistency). It replaces only account resolution: no
// registration, no adoption choice, no email-based linking.
func (h *AuthHandler) completeEnterpriseOIDCLogin(
	c *gin.Context,
	cfg config.OIDCConnectConfig,
	prefix, frontendCallback, redirectTo, intent, issuer, subject, compatEmail, username string,
	upstreamClaims map[string]any,
) {
	secure := isRequestHTTPS(c)
	clearPending := func() {
		clearOAuthPendingSessionCookie(c, secure)
		clearOAuthPendingBrowserCookie(c, secure)
	}
	if intent == oauthIntentBindCurrentUser {
		clearPending()
		redirectOAuthError(c, frontendCallback, "enterprise_bind_disabled", "account binding is disabled in enterprise mode", "")
		return
	}
	if normalizeEnterpriseIssuer(issuer) != normalizeEnterpriseIssuer(cfg.IssuerURL) {
		clearPending()
		redirectOAuthError(c, frontendCallback, "enterprise_issuer_mismatch", "unexpected issuer", "")
		return
	}
	input := service.EnterpriseOIDCLoginInput{
		Prefix:           prefix,
		ProviderKey:      issuer,
		ProviderSubject:  subject,
		Email:            compatEmail,
		Username:         username,
		DisplayName:      pendingSessionStringValue(upstreamClaims, "suggested_display_name"),
		AvatarURL:        pendingSessionStringValue(upstreamClaims, "suggested_avatar_url"),
		UpstreamMetadata: upstreamClaims,
	}
	fail := func(err error) {
		clearPending()
		code, ok := enterpriseOIDCErrorCodes[infraerrors.Reason(err)]
		if !ok {
			code = "session_error"
		}
		redirectOAuthError(c, frontendCallback, code, infraerrors.Reason(err), "")
	}
	ctx := c.Request.Context()
	user, err := h.authService.ResolveEnterpriseBoundOIDCUser(ctx, input)
	if err != nil {
		fail(err)
		return
	}
	if err := h.ensureBackendModeAllowsUser(ctx, user); err != nil {
		fail(err)
		return
	}
	tokenPair, err := h.authService.CompleteEnterpriseBoundOIDCLogin(ctx, user, input)
	if err != nil {
		fail(err)
		return
	}
	fragment := url.Values{}
	fragment.Set("access_token", tokenPair.AccessToken)
	fragment.Set("refresh_token", tokenPair.RefreshToken)
	fragment.Set("expires_in", fmt.Sprintf("%d", tokenPair.ExpiresIn))
	fragment.Set("token_type", "Bearer")
	fragment.Set("redirect", redirectTo)
	clearPending()
	redirectWithFragment(c, frontendCallback, fragment)
}
