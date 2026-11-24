package handler

// 企业OS（SSO-20261115-05）：解析与完成之间账号状态变化（本地审查 A）。

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

// Reviewer reproduction (japi-interim-review.md, finding A), plus replacement, disablement and role change.
func TestEnterpriseOIDCAccountChangedBetweenResolveAndComplete(t *testing.T) {
	cases := []struct {
		name   string
		change func(t *testing.T, h *AuthHandler, id int64)
		reason string
	}{
		{"binding removed", func(t *testing.T, h *AuthHandler, id int64) {
			setUserField(t, h, id, "notes", "binding removed by admin")
		}, "ENTERPRISE_BINDING_MISMATCH"},
		{"binding replaced", func(t *testing.T, h *AuthHandler, id int64) {
			setUserField(t, h, id, "notes", "os-bridge casdoor:cas-someone-else")
		}, "ENTERPRISE_BINDING_MISMATCH"},
		{"disabled", func(t *testing.T, h *AuthHandler, id int64) { setUserField(t, h, id, "status", service.StatusDisabled) }, "USER_NOT_ACTIVE"},
		{"made admin", func(t *testing.T, h *AuthHandler, id int64) { setUserField(t, h, id, "role", service.RoleAdmin) }, "ENTERPRISE_ADMIN_REFUSED"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject := "cas-race-" + string(rune('a'+i))
			email := subject + "@acme.example"
			p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: subject, Email: email})
			h, client := enterpriseHandler(t, p.cfg, nil)
			u := createEnterpriseUser(t, client, email, "os-bridge casdoor:"+subject, service.RoleUser, service.StatusActive)
			ctx := context.Background()
			in := service.EnterpriseOIDCLoginInput{Prefix: enterprisePrefix, ProviderKey: p.cfg.IssuerURL, ProviderSubject: subject, Email: u.Email}
			resolved, err := h.authService.ResolveEnterpriseBoundOIDCUser(ctx, in)
			require.NoError(t, err)
			tc.change(t, h, u.ID)
			pair, err := h.authService.CompleteEnterpriseBoundOIDCLogin(ctx, resolved, in)
			require.Error(t, err)
			require.Contains(t, err.Error(), tc.reason)
			require.Nil(t, pair)
			require.Zero(t, countIdentities(t, client, subject), "no identity row is written for a withdrawn authorization")
		})
	}
}

func setUserField(t *testing.T, h *AuthHandler, id int64, field, value string) {
	t.Helper()
	update := h.entClient().User.UpdateOneID(id)
	switch field {
	case "notes":
		update.SetNotes(value)
	case "status":
		update.SetStatus(value)
	case "role":
		update.SetRole(value)
	}
	_, err := update.Save(context.Background())
	require.NoError(t, err)
}

// Real concurrency (not a scripted interleaving): several goroutines complete the first login of the same new
// identity at once against the shared test database. Invariants: at most one identity row; it belongs to the
// bound account; every success issued a token for that account; failures are safe refusals (never a token).
func TestEnterpriseOIDCConcurrentCompletionKeepsOneIdentity(t *testing.T) {
	p := newEnterpriseOIDCProvider(t, enterpriseFixture{Subject: "cas-conc", Email: "conc@acme.example"})
	h, client := enterpriseHandler(t, p.cfg, nil)
	u := createEnterpriseUser(t, client, "conc@acme.example", "os-bridge casdoor:cas-conc", service.RoleUser, service.StatusActive)
	ctx := context.Background()
	in := service.EnterpriseOIDCLoginInput{Prefix: enterprisePrefix, ProviderKey: p.cfg.IssuerURL, ProviderSubject: "cas-conc", Email: u.Email}
	resolved, err := h.authService.ResolveEnterpriseBoundOIDCUser(ctx, in)
	require.NoError(t, err)

	const workers = 6
	type outcome struct {
		pair *service.TokenPair
		err  error
	}
	results := make(chan outcome, workers)
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		go func() {
			<-start
			pair, err := h.authService.CompleteEnterpriseBoundOIDCLogin(ctx, resolved, in)
			results <- outcome{pair, err}
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < workers; i++ {
		r := <-results
		if r.err != nil {
			require.Nil(t, r.pair)
			t.Logf("concurrent completion refused safely: %v", r.err)
			continue
		}
		successes++
		claims, err := h.authService.ValidateToken(r.pair.AccessToken)
		require.NoError(t, err)
		require.Equal(t, u.ID, claims.UserID)
	}
	require.GreaterOrEqual(t, successes, 1, "at least one concurrent completion succeeds")
	rows, err := client.AuthIdentity.Query().All(ctx)
	require.NoError(t, err)
	owned := 0
	for _, row := range rows {
		if row.ProviderSubject == "cas-conc" {
			owned++
			require.Equal(t, u.ID, row.UserID)
		}
	}
	require.Equal(t, 1, owned, "exactly one identity row for the subject")
	t.Logf("concurrent completions: %d of %d succeeded", successes, workers)
}
