package admin

import (
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func TestQyosBindingProjection(t *testing.T) {
	t.Setenv("QYOS_BINDING_READER_KEY_ID", "bridge")
	u := &service.User{Notes: "staff-only note\nos-bridge casdoor:employee-1"}
	for _, tc := range []struct {
		id       string
		scopes   []string
		expected bool
	}{
		{"bridge", []string{"users.read"}, true},
		{"other", []string{"users.read"}, false},
		{"bridge", nil, false},
	} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		req := httptest.NewRequest("GET", "/", nil)
		c.Request = req.WithContext(adminaccess.WithPrincipal(req.Context(), &adminaccess.Principal{KeyID: tc.id, Policy: adminaccess.Policy{GlobalPermissions: tc.scopes}}))
		got, exists := adminUserResponse(c, u).(gin.H)["notes"]
		if exists != tc.expected || (exists && got != "os-bridge casdoor:employee-1") {
			t.Fatalf("unexpected projection for %s: %v", tc.id, got)
		}
	}
	if got := qyosBindingProjection("os-bridge casdoor:a os-bridge casdoor:b"); got != qyosBindingPrefix+"!invalid-binding!" {
		t.Fatalf("ambiguous record was accepted: %q", got)
	}
}

func TestQyosBindingMerge(t *testing.T) {
	const private = "original note"
	const marker = "os-bridge casdoor:employee-1"
	got, err := mergeQyosBinding(private, marker)
	if err != nil || got != private+"\n"+marker {
		t.Fatalf("notes not preserved: %q %v", got, err)
	}
	retry, err := mergeQyosBinding(got, marker)
	if err != nil || retry != got {
		t.Fatalf("retry changed notes: %q %v", retry, err)
	}
	for _, input := range []string{"os-bridge casdoor:employee-2", marker + " extra data", "", "replacement note"} {
		if _, err := mergeQyosBinding(got, input); err == nil {
			t.Fatalf("unexpected write: %q", input)
		}
	}
}
