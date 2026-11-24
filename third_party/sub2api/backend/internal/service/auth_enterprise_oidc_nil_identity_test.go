package service

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// SSO-20261115-05: ensureEmailAuthIdentity returns a nil identity when its write fails (seen under concurrent
// logins); the first-bind check must not dereference it (it previously panicked before its own nil check).
func TestShouldApplyEmailFirstBindDefaultsNilIdentity(t *testing.T) {
	var s *AuthService
	require.NotPanics(t, func() { require.False(t, s.shouldApplyEmailFirstBindDefaults(context.Background(), 1, nil, false)) })
	require.NotPanics(t, func() {
		require.False(t, (&AuthService{}).shouldApplyEmailFirstBindDefaults(context.Background(), 1, nil, true))
	})
}
