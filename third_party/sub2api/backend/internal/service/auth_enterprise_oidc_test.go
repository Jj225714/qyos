package service

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

// Same table as os-bridge bindingOf (enterprise-os/os-bridge/src/provisioner.mjs).
func TestBindingSubject(t *testing.T) {
	p := config.EnterpriseBindingPrefixOSBridge
	cases := map[string]string{
		"os-bridge casdoor:cas-1":                      "cas-1",
		"legacy note os-bridge casdoor:cas-2":          "cas-2",
		"os-bridge casdoor:cas-3 [os-bridge-disabled]": "cas-3",
		"note\tos-bridge casdoor:cas-4":                "cas-4",
		"xos-bridge casdoor:cas-5":                     "",
		"os-bridge casdoor:":                           "",
		"":                                             "",
		"something else entirely":                      "",
		"os-bridge casdoor:a os-bridge casdoor:b":      "a",
	}
	for notes, want := range cases {
		require.Equal(t, want, BindingSubject(notes, p), notes)
	}
	require.Equal(t, "", BindingSubject("os-bridge casdoor:cas-1", ""))
}

func enterpriseConfig() config.OIDCConnectConfig {
	return config.OIDCConnectConfig{
		Enabled:                 true,
		ClientID:                "client",
		ClientSecret:            "secret",
		IssuerURL:               "https://sso.example.com",
		JWKSURL:                 "https://sso.example.com/.well-known/japi/jwks",
		RedirectURL:             "https://japi.example.com/api/v1/auth/oauth/oidc/callback",
		TokenAuthMethod:         "client_secret_post",
		UsePKCE:                 true,
		ValidateIDToken:         true,
		AllowedSigningAlgs:      "RS256",
		EnterpriseBindingPrefix: config.EnterpriseBindingPrefixOSBridge,
	}
}

func TestEnterpriseOIDCConfigError(t *testing.T) {
	require.NoError(t, EnterpriseOIDCConfigError(enterpriseConfig()))
	off := enterpriseConfig()
	off.EnterpriseBindingPrefix = ""
	off.UsePKCE = false
	require.NoError(t, EnterpriseOIDCConfigError(off), "prefix unset: upstream behaviour, no enterprise contract")

	basic := enterpriseConfig()
	basic.TokenAuthMethod = "client_secret_basic"
	require.NoError(t, EnterpriseOIDCConfigError(basic))
	loopback := enterpriseConfig()
	loopback.IssuerURL = "http://127.0.0.1:9000"
	loopback.JWKSURL = "http://127.0.0.1:9000/jwks"
	require.NoError(t, EnterpriseOIDCConfigError(loopback), "plain http only for loopback (local tests)")

	bad := map[string]func(*config.OIDCConnectConfig){
		"wrong prefix":           func(c *config.OIDCConnectConfig) { c.EnterpriseBindingPrefix = "other:" },
		"disabled":               func(c *config.OIDCConnectConfig) { c.Enabled = false },
		"no pkce":                func(c *config.OIDCConnectConfig) { c.UsePKCE = false },
		"no id token validation": func(c *config.OIDCConnectConfig) { c.ValidateIDToken = false },
		"http issuer": func(c *config.OIDCConnectConfig) {
			c.IssuerURL = "http://sso.example.com"
			c.JWKSURL = "http://sso.example.com/jwks"
		},
		"jwks other host":                 func(c *config.OIDCConnectConfig) { c.JWKSURL = "https://evil.example.com/jwks" },
		"jwks empty":                      func(c *config.OIDCConnectConfig) { c.JWKSURL = "" },
		"hs256":                           func(c *config.OIDCConnectConfig) { c.AllowedSigningAlgs = "HS256" },
		"mixed algs":                      func(c *config.OIDCConnectConfig) { c.AllowedSigningAlgs = "RS256,none" },
		"no algs":                         func(c *config.OIDCConnectConfig) { c.AllowedSigningAlgs = " , " },
		"C1 empty secret with post":       func(c *config.OIDCConnectConfig) { c.ClientSecret = "" },
		"C1 empty secret with basic":      func(c *config.OIDCConnectConfig) { c.TokenAuthMethod = "client_secret_basic"; c.ClientSecret = " " },
		"C1 none with a non-empty secret": func(c *config.OIDCConnectConfig) { c.TokenAuthMethod = "none" },
		"unknown token method":            func(c *config.OIDCConnectConfig) { c.TokenAuthMethod = "private_key_jwt" },
		"no client id":                    func(c *config.OIDCConnectConfig) { c.ClientID = "" },
		"no redirect":                     func(c *config.OIDCConnectConfig) { c.RedirectURL = "" },
	}
	for name, mutate := range bad {
		cfg := enterpriseConfig()
		mutate(&cfg)
		err := EnterpriseOIDCConfigError(cfg)
		require.Error(t, err, name)
		require.Contains(t, err.Error(), "ENTERPRISE_OIDC_MISCONFIGURED", name)
	}
}
