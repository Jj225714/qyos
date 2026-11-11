//go:build unit

package routes

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	adminhandler "github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type enterpriseSyncAdminService struct{ service.AdminService }

func (*enterpriseSyncAdminService) GetUser(_ context.Context, id int64) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleUser, Status: service.StatusActive}, nil
}
func (*enterpriseSyncAdminService) CreateUser(_ context.Context, in *service.CreateUserInput) (*service.User, error) {
	return &service.User{ID: 100, Email: in.Email, Role: service.RoleUser, Status: service.StatusActive}, nil
}
func (*enterpriseSyncAdminService) UpdateUser(_ context.Context, id int64, _ *service.UpdateUserInput) (*service.User, error) {
	return &service.User{ID: id, Role: service.RoleUser, Status: service.StatusActive}, nil
}
func (*enterpriseSyncAdminService) GetUserAPIKeys(context.Context, int64, int, int, string, string) ([]service.APIKey, int64, error) {
	return nil, 0, nil
}
func (*enterpriseSyncAdminService) AdminUpdateAPIKeyGroupID(_ context.Context, keyID int64, _ *int64) (*service.AdminUpdateAPIKeyGroupIDResult, error) {
	return &service.AdminUpdateAPIKeyGroupIDResult{APIKey: &service.APIKey{ID: keyID}}, nil
}

// os-bridge 用的受限管理密钥：每条新权限只放行自己的路由，未勾选时一律 403。
func TestScopedAdminKeyEnterpriseDirectorySyncRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		permission, method, path, body string
	}{
		{"users.create", "POST", "/users", `{"email":"e@example.com","password":"secret123"}`},
		{"users.update", "PUT", "/users/7", `{"status":"disabled"}`},
		{"users.api_keys.read", "GET", "/users/7/api-keys", ``},
		{"users.api_keys.create", "POST", "/users/7/api-keys", `{"name":"enterprise-os"}`},
		{"api_keys.group.write", "PUT", "/api-keys/8", `{"group_id":0}`},
		{"api_keys.status.write", "PUT", "/api-keys/8/status", `{"status":"disabled"}`},
	}
	all := make([]string, 0, len(cases))
	for _, tc := range cases {
		all = append(all, tc.permission)
	}
	for _, granted := range append([][]string{nil, {"users.read"}, all}, func() [][]string {
		single := make([][]string, 0, len(cases))
		for _, tc := range cases {
			single = append(single, []string{tc.permission})
		}
		return single
	}()...) {
		keys := &scopedRouteKeys{}
		settings := service.NewSettingService(nil, nil)
		settings.SetScopedAdminKeyRepository(keys)
		key, _, err := settings.CreateScopedAdminKey(context.Background(), service.ScopedAdminKeyInput{
			Name: "os-bridge", Enabled: true, Policy: adminaccess.Policy{GlobalPermissions: granted},
		}, 9)
		require.NoError(t, err)
		auth := middleware.NewAdminAuthMiddleware(nil, service.NewUserService(&scopedRouteUsers{}, nil, nil, nil), settings, nil)
		stub := &enterpriseSyncAdminService{}
		r := gin.New()
		RegisterAdminRoutes(r.Group("/api/v1"), &handler.Handlers{Admin: &handler.AdminHandlers{
			Account: &adminhandler.AccountHandler{},
			User:    adminhandler.NewUserHandler(stub, nil, nil, nil, nil, nil, nil),
			APIKey:  adminhandler.NewAdminAPIKeyHandler(stub, nil),
			Setting: adminhandler.NewSettingHandler(settings, nil, nil, nil, nil, nil, nil),
		}}, auth, middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() }), middleware.StepUpAuthMiddleware(func(c *gin.Context) { c.Next() }), nil, nil)
		for _, tc := range cases {
			req := httptest.NewRequest(tc.method, "/api/v1/admin"+tc.path, strings.NewReader(tc.body))
			req.Header.Set("x-api-key", key)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			allowed := false
			for _, p := range granted {
				allowed = allowed || p == tc.permission
			}
			if allowed {
				require.NotEqual(t, 403, w.Code, "%v %s %s: %s", granted, tc.method, tc.path, w.Body.String())
				require.NotEqual(t, 401, w.Code, "%v %s %s: %s", granted, tc.method, tc.path, w.Body.String())
			} else {
				require.Equal(t, 403, w.Code, "%v %s %s: %s", granted, tc.method, tc.path, w.Body.String())
			}
		}
	}
}
