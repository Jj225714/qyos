package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestAdminUserAPIKeyRoutesHaveStableAuditActions(t *testing.T) {
	expected := map[string]string{
		"POST /api/v1/admin/users/:id/api-keys": "admin.users.api_keys.create",
		"PUT /api/v1/admin/api-keys/:id/status": "admin.api_keys.status.update",
		"PUT /api/v1/admin/api-keys/:id":        "admin.api_keys.group.update",
	}
	for route, action := range expected {
		require.Equal(t, action, auditActionOverrides[route], route)
	}
	require.Equal(t, "admin.api_keys.status.update", AuditActionForRoute("PUT", "/api/v1/admin/api-keys/:id/status"))
	require.Equal(t, "admin.users.update", AuditActionForRoute("PUT", "/api/v1/admin/users/:id"), "未登记的路由按模板推导")
}

// 管理员代建 Key 的响应含明文 Key；审计只能记录请求体，明文不得进入审计库。
func TestAdminCreateUserAPIKeyAuditOmitsPlaintextKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repository := &auditCaptureRepository{}
	auditService := service.NewAuditLogService(repository, nil)
	auditService.Start()

	const plaintext = "sk-audit-canary-plaintext-key"
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(string(ContextKeyUser), AuthSubject{UserID: 77})
		c.Set(string(ContextKeyUserRole), "admin")
		c.Next()
	})
	router.Use(gin.HandlerFunc(NewAuditLogMiddleware(auditService)))
	router.POST("/api/v1/admin/users/:id/api-keys", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"id": 1, "key": plaintext}})
	})
	router.PUT("/api/v1/admin/api-keys/:id/status", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"id": 1, "key": plaintext, "status": "disabled"}})
	})

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/v1/admin/users/12/api-keys", `{"name":"enterprise-os","group_id":3}`},
		{http.MethodPut, "/api/v1/admin/api-keys/1/status", `{"status":"disabled"}`},
	} {
		req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		require.Contains(t, rec.Body.String(), plaintext)
	}
	auditService.Stop()

	repository.mu.Lock()
	logs := append([]*service.AuditLog(nil), repository.logs...)
	repository.mu.Unlock()
	require.Len(t, logs, 2)
	actions := map[string]bool{}
	for _, entry := range logs {
		actions[entry.Action] = true
		data, err := json.Marshal(entry)
		require.NoError(t, err)
		require.NotContains(t, string(data), plaintext)
	}
	require.True(t, actions["admin.users.api_keys.create"])
	require.True(t, actions["admin.api_keys.status.update"])
}

// 受限管理密钥的请求统一记为 admin.api_key.request，具体动作写入 extra.route_action。
func TestScopedAdminKeyAuditRecordsRouteAction(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repository := &auditCaptureRepository{}
	auditService := service.NewAuditLogService(repository, nil)
	auditService.Start()

	item := &service.ScopedAdminKey{ID: "key-id", CreatedBy: 9, ScopedAdminKeyInput: service.ScopedAdminKeyInput{Name: "os-bridge"}}
	router := gin.New()
	router.PUT("/api/v1/admin/api-keys/:id/status", func(c *gin.Context) {
		c.Status(http.StatusOK)
		recordAdminKeyRequest(c, auditService, item)
	})
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/api-keys/5/status", bytes.NewBufferString(`{"status":"disabled"}`))
	router.ServeHTTP(httptest.NewRecorder(), req)
	auditService.Stop()

	repository.mu.Lock()
	defer repository.mu.Unlock()
	require.Len(t, repository.logs, 1)
	entry := repository.logs[0]
	require.Equal(t, "admin.api_key.request", entry.Action)
	require.Equal(t, "admin.api_keys.status.update", entry.Extra["route_action"])
	require.Equal(t, "key-id", entry.Extra["admin_key_id"])
}
