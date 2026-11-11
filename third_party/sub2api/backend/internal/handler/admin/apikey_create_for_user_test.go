package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type fakeUserAPIKeyService struct {
	userID int64
	req    service.CreateAPIKeyRequest
	err    error

	keys        map[int64]*service.APIKey
	getErr      error
	updateErr   error
	updateCalls int
	updateID    int64
	updateUser  int64
	updateReq   service.UpdateAPIKeyRequest
}

func (f *fakeUserAPIKeyService) Create(_ context.Context, userID int64, req service.CreateAPIKeyRequest) (*service.APIKey, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.userID, f.req = userID, req
	return &service.APIKey{ID: 77, UserID: userID, Key: "sk-created", Name: req.Name, GroupID: req.GroupID, Status: service.StatusActive}, nil
}

func (f *fakeUserAPIKeyService) GetByID(_ context.Context, id int64) (*service.APIKey, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	key, ok := f.keys[id]
	if !ok {
		return nil, service.ErrAPIKeyNotFound
	}
	cp := *key
	return &cp, nil
}

func (f *fakeUserAPIKeyService) Update(_ context.Context, id int64, userID int64, req service.UpdateAPIKeyRequest) (*service.APIKey, error) {
	f.updateCalls++
	f.updateID, f.updateUser, f.updateReq = id, userID, req
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	key := *f.keys[id]
	if req.Status != nil {
		key.Status = *req.Status
	}
	return &key, nil
}

func setupCreateForUser(adminSvc service.AdminService, keySvc UserAPIKeyService) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	h := &AdminAPIKeyHandler{adminService: adminSvc, keyService: keySvc}
	router.POST("/api/v1/admin/users/:id/api-keys", h.CreateForUser)
	return router
}

func postCreateForUser(router *gin.Engine, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

type errorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Reason  string `json:"reason"`
}

func decodeErrorBody(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	require.Contains(t, rec.Header().Get("Content-Type"), "application/json")
	var body errorBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func TestAdminAPIKeyHandler_CreateForUser_Success(t *testing.T) {
	creator := &fakeUserAPIKeyService{}
	router := setupCreateForUser(newStubAdminService(), creator)

	rec := postCreateForUser(router, "/api/v1/admin/users/12/api-keys", `{"name":" enterprise-os ","group_id":3}`)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, int64(12), creator.userID)
	require.Equal(t, "enterprise-os", creator.req.Name)
	require.NotNil(t, creator.req.GroupID)
	require.Equal(t, int64(3), *creator.req.GroupID)
	var resp struct {
		Code int `json:"code"`
		Data struct {
			Key    string `json:"key"`
			UserID int64  `json:"user_id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Equal(t, 0, resp.Code)
	require.Equal(t, "sk-created", resp.Data.Key)
	require.Equal(t, int64(12), resp.Data.UserID)
}

func TestAdminAPIKeyHandler_CreateForUser_ZeroGroupMeansDefault(t *testing.T) {
	creator := &fakeUserAPIKeyService{}
	router := setupCreateForUser(newStubAdminService(), creator)

	rec := postCreateForUser(router, "/api/v1/admin/users/12/api-keys", `{"name":"k","group_id":0}`)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Nil(t, creator.req.GroupID)
}

func TestAdminAPIKeyHandler_CreateForUser_InvalidInput(t *testing.T) {
	router := setupCreateForUser(newStubAdminService(), &fakeUserAPIKeyService{})

	require.Equal(t, http.StatusBadRequest, postCreateForUser(router, "/api/v1/admin/users/abc/api-keys", `{"name":"k"}`).Code)
	require.Equal(t, http.StatusBadRequest, postCreateForUser(router, "/api/v1/admin/users/0/api-keys", `{"name":"k"}`).Code)
	require.Equal(t, http.StatusBadRequest, postCreateForUser(router, "/api/v1/admin/users/1/api-keys", `{}`).Code)
	require.Equal(t, http.StatusBadRequest, postCreateForUser(router, "/api/v1/admin/users/1/api-keys", `{"name":"   "}`).Code)
	require.Equal(t, http.StatusBadRequest, postCreateForUser(router, "/api/v1/admin/users/1/api-keys", `{bad`).Code)
}

func TestAdminAPIKeyHandler_CreateForUser_UnknownUserReturnsJSON404(t *testing.T) {
	adminSvc := newStubAdminService()
	adminSvc.getUserErr = service.ErrUserNotFound
	creator := &fakeUserAPIKeyService{}
	router := setupCreateForUser(adminSvc, creator)

	rec := postCreateForUser(router, "/api/v1/admin/users/99/api-keys", `{"name":"k"}`)

	require.Equal(t, http.StatusNotFound, rec.Code)
	body := decodeErrorBody(t, rec)
	require.Equal(t, http.StatusNotFound, body.Code)
	require.Equal(t, "USER_NOT_FOUND", body.Reason)
	require.Zero(t, creator.userID)
}

func TestAdminAPIKeyHandler_CreateForUser_RejectsInactiveUser(t *testing.T) {
	adminSvc := newStubAdminService()
	adminSvc.users = append(adminSvc.users, service.User{ID: 21, Role: service.RoleUser, Status: service.StatusDisabled})
	creator := &fakeUserAPIKeyService{}
	router := setupCreateForUser(adminSvc, creator)

	rec := postCreateForUser(router, "/api/v1/admin/users/21/api-keys", `{"name":"k"}`)

	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "USER_NOT_ACTIVE", decodeErrorBody(t, rec).Reason)
	require.Zero(t, creator.userID)
}

func TestAdminAPIKeyHandler_CreateForUser_RejectsAdminUser(t *testing.T) {
	for _, status := range []string{service.StatusActive, service.StatusDisabled} {
		adminSvc := newStubAdminService()
		adminSvc.users = append(adminSvc.users, service.User{ID: 22, Role: service.RoleAdmin, Status: status})
		creator := &fakeUserAPIKeyService{}
		router := setupCreateForUser(adminSvc, creator)

		rec := postCreateForUser(router, "/api/v1/admin/users/22/api-keys", `{"name":"k"}`)

		require.Equal(t, http.StatusForbidden, rec.Code, status)
		require.Equal(t, "ADMIN_USER_API_KEY_FORBIDDEN", decodeErrorBody(t, rec).Reason)
		require.Zero(t, creator.userID)
	}
}

func TestAdminAPIKeyHandler_CreateForUser_ServiceError(t *testing.T) {
	router := setupCreateForUser(newStubAdminService(), &fakeUserAPIKeyService{err: errors.New("boom")})

	rec := postCreateForUser(router, "/api/v1/admin/users/12/api-keys", `{"name":"k"}`)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestAdminAPIKeyHandler_CreateForUser_NotConfigured(t *testing.T) {
	router := setupCreateForUser(newStubAdminService(), nil)

	rec := postCreateForUser(router, "/api/v1/admin/users/12/api-keys", `{"name":"k"}`)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
