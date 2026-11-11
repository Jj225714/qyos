package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func setupScopedUserWrites(adminSvc service.AdminService, permissions ...string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(withScopedPrincipal(permissions...))
	h := NewUserHandler(adminSvc, nil, nil, nil, nil, nil, nil)
	router.POST("/api/v1/admin/users", h.Create)
	router.PUT("/api/v1/admin/users/:id", h.Update)
	return router
}

func sendUserWrite(router *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

func TestScopedUserCreateRejectsAdminAndUnauthorizedBalance(t *testing.T) {
	router := setupScopedUserWrites(newStatusAdminService(), "users.create")

	rec := sendUserWrite(router, http.MethodPost, "/api/v1/admin/users", `{"email":"a@example.com","password":"secret123","role":"admin"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_TARGET_FORBIDDEN", decodeErrorBody(t, rec).Reason)

	rec = sendUserWrite(router, http.MethodPost, "/api/v1/admin/users", `{"email":"a@example.com","password":"secret123","balance":10}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_BALANCE_WRITE_REQUIRED", decodeErrorBody(t, rec).Reason)

	router = setupScopedUserWrites(newStatusAdminService(), "users.create", "users.balance.write")
	rec = sendUserWrite(router, http.MethodPost, "/api/v1/admin/users", `{"email":"a@example.com","password":"secret123","balance":10}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestScopedUserCreateResponseFollowsReadPermissions(t *testing.T) {
	for _, tc := range []struct {
		permissions []string
		wantEmail   bool
	}{
		{[]string{"users.create"}, false},
		{[]string{"users.create", "users.read"}, true},
	} {
		router := setupScopedUserWrites(newStatusAdminService(), tc.permissions...)
		rec := sendUserWrite(router, http.MethodPost, "/api/v1/admin/users", `{"email":"new@example.com","password":"secret123","username":"员工"}`)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var resp struct {
			Data map[string]json.RawMessage `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		require.JSONEq(t, `100`, string(resp.Data["id"]))
		_, hasEmail := resp.Data["email"]
		require.Equal(t, tc.wantEmail, hasEmail, tc.permissions)
		require.NotContains(t, resp.Data, "balance")
		require.NotContains(t, resp.Data, "notes")
	}
}

func TestScopedUserUpdateBoundaries(t *testing.T) {
	router := setupScopedUserWrites(newStatusAdminService(), "users.update")

	// 管理员账号（ID 5）不可被受限密钥修改，哪怕只是改状态。
	rec := sendUserWrite(router, http.MethodPut, "/api/v1/admin/users/5", `{"status":"disabled"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_TARGET_FORBIDDEN", decodeErrorBody(t, rec).Reason)

	// 不能把普通用户提升为管理员。
	rec = sendUserWrite(router, http.MethodPut, "/api/v1/admin/users/1", `{"role":"admin"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_TARGET_FORBIDDEN", decodeErrorBody(t, rec).Reason)

	// 余额需要额外的 users.balance.write。
	rec = sendUserWrite(router, http.MethodPut, "/api/v1/admin/users/1", `{"balance":5}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_BALANCE_WRITE_REQUIRED", decodeErrorBody(t, rec).Reason)

	// 普通资料与状态可以修改，响应只含 id（未授权 users.read）。
	rec = sendUserWrite(router, http.MethodPut, "/api/v1/admin/users/1", `{"status":"disabled","username":"离职员工","role":"user"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var resp struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Equal(t, []string{"id"}, rawMessageKeys(resp.Data))

	// 不存在的用户返回 JSON 404。
	missing := newStatusAdminService()
	missing.getUserErr = service.ErrUserNotFound
	rec = sendUserWrite(setupScopedUserWrites(missing, "users.update"), http.MethodPut, "/api/v1/admin/users/99", `{"status":"disabled"}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "USER_NOT_FOUND", decodeErrorBody(t, rec).Reason)
}

func rawMessageKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
