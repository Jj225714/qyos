package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// withScopedPrincipal 模拟受限管理密钥（adm_sc_…）通过鉴权后的请求上下文。
func withScopedPrincipal(permissions ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := &adminaccess.Principal{KeyID: "scoped", Policy: adminaccess.Policy{GlobalPermissions: permissions}}
		c.Request = c.Request.WithContext(adminaccess.WithPrincipal(c.Request.Context(), p))
		c.Next()
	}
}

func newStatusKeyService() *fakeUserAPIKeyService {
	return &fakeUserAPIKeyService{keys: map[int64]*service.APIKey{
		10: {ID: 10, UserID: 1, Key: "sk-active", Status: service.StatusActive},
		11: {ID: 11, UserID: 1, Key: "sk-disabled", Status: service.StatusDisabled},
		12: {ID: 12, UserID: 1, Key: "sk-expired", Status: service.StatusAPIKeyExpired},
		13: {ID: 13, UserID: 1, Key: "sk-quota", Status: service.StatusAPIKeyQuotaExhausted},
		20: {ID: 20, UserID: 5, Key: "sk-admin", Status: service.StatusActive},
	}}
}

func newStatusAdminService() *stubAdminService {
	adminSvc := newStubAdminService()
	adminSvc.users = append(adminSvc.users, service.User{ID: 5, Role: service.RoleAdmin, Status: service.StatusActive})
	return adminSvc
}

func setupAPIKeyStatus(adminSvc service.AdminService, keySvc UserAPIKeyService, middlewares ...gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(middlewares...)
	h := &AdminAPIKeyHandler{adminService: adminSvc, keyService: keySvc}
	router.PUT("/api/v1/admin/api-keys/:id/status", h.UpdateStatus)
	router.PUT("/api/v1/admin/api-keys/:id", h.UpdateGroup)
	return router
}

func putJSON(router *gin.Engine, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

func decodeAPIKeyData(t *testing.T, rec *httptest.ResponseRecorder) (int64, string) {
	t.Helper()
	var resp struct {
		Code int `json:"code"`
		Data struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp), rec.Body.String())
	require.Equal(t, 0, resp.Code)
	return resp.Data.ID, resp.Data.Status
}

func TestAdminAPIKeyHandler_UpdateStatus_DisableAndEnable(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	rec := putJSON(router, "/api/v1/admin/api-keys/10/status", `{"status":"disabled"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	id, status := decodeAPIKeyData(t, rec)
	require.Equal(t, int64(10), id)
	require.Equal(t, service.StatusDisabled, status)
	require.Equal(t, 1, keySvc.updateCalls)
	require.Equal(t, int64(10), keySvc.updateID)
	require.Equal(t, int64(1), keySvc.updateUser, "必须以 Key 所有者身份走 service 更新，才能复用所有权校验与鉴权缓存失效")
	require.NotNil(t, keySvc.updateReq.Status)
	require.Equal(t, service.StatusDisabled, *keySvc.updateReq.Status)
	require.Nil(t, keySvc.updateReq.GroupID)
	require.Nil(t, keySvc.updateReq.Quota)

	rec = putJSON(router, "/api/v1/admin/api-keys/11/status", `{"status":"active"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	_, status = decodeAPIKeyData(t, rec)
	require.Equal(t, service.StatusActive, status)
	require.Equal(t, 2, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_UpdateStatus_SameStatusIsNoop(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	rec := putJSON(router, "/api/v1/admin/api-keys/10/status", `{"status":"active"}`)

	require.Equal(t, http.StatusOK, rec.Code)
	_, status := decodeAPIKeyData(t, rec)
	require.Equal(t, service.StatusActive, status)
	require.Zero(t, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_UpdateStatus_InvalidInput(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	for _, tc := range []struct{ path, body string }{
		{"/api/v1/admin/api-keys/abc/status", `{"status":"disabled"}`},
		{"/api/v1/admin/api-keys/0/status", `{"status":"disabled"}`},
		{"/api/v1/admin/api-keys/10/status", `{}`},
		{"/api/v1/admin/api-keys/10/status", `{"status":"expired"}`},
		{"/api/v1/admin/api-keys/10/status", `{"status":"quota_exhausted"}`},
		{"/api/v1/admin/api-keys/10/status", `{"status":"ACTIVE"}`},
		{"/api/v1/admin/api-keys/10/status", `{bad`},
	} {
		rec := putJSON(router, tc.path, tc.body)
		require.Equal(t, http.StatusBadRequest, rec.Code, tc.path+" "+tc.body)
	}
	require.Zero(t, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_UpdateStatus_NotFound(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	rec := putJSON(router, "/api/v1/admin/api-keys/404/status", `{"status":"disabled"}`)

	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Equal(t, "API_KEY_NOT_FOUND", decodeErrorBody(t, rec).Reason)
	require.Zero(t, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_UpdateStatus_CannotReviveExpiredOrExhaustedKey(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	for _, path := range []string{"/api/v1/admin/api-keys/12/status", "/api/v1/admin/api-keys/13/status"} {
		rec := putJSON(router, path, `{"status":"active"}`)
		require.Equal(t, http.StatusConflict, rec.Code, path)
		require.Equal(t, "API_KEY_STATUS_CONFLICT", decodeErrorBody(t, rec).Reason)
	}
	require.Zero(t, keySvc.updateCalls)

	// 停用不受当前状态限制。
	rec := putJSON(router, "/api/v1/admin/api-keys/12/status", `{"status":"disabled"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, 1, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_UpdateStatus_NotConfigured(t *testing.T) {
	router := setupAPIKeyStatus(newStatusAdminService(), nil)

	rec := putJSON(router, "/api/v1/admin/api-keys/10/status", `{"status":"disabled"}`)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAdminAPIKeyHandler_ScopedKeyCannotManageAdminOwnedKeys(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc, withScopedPrincipal("api_keys.status.write", "api_keys.group.write"))

	rec := putJSON(router, "/api/v1/admin/api-keys/20/status", `{"status":"disabled"}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_TARGET_FORBIDDEN", decodeErrorBody(t, rec).Reason)

	rec = putJSON(router, "/api/v1/admin/api-keys/20", `{"group_id":2}`)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "SCOPED_ADMIN_TARGET_FORBIDDEN", decodeErrorBody(t, rec).Reason)
	require.Zero(t, keySvc.updateCalls)

	// 普通用户名下的 Key 照常可管理。
	rec = putJSON(router, "/api/v1/admin/api-keys/10/status", `{"status":"disabled"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, 1, keySvc.updateCalls)
}

func TestAdminAPIKeyHandler_FullAccessSessionMayManageAdminOwnedKeys(t *testing.T) {
	keySvc := newStatusKeyService()
	router := setupAPIKeyStatus(newStatusAdminService(), keySvc)

	rec := putJSON(router, "/api/v1/admin/api-keys/20/status", `{"status":"disabled"}`)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, 1, keySvc.updateCalls)
}
