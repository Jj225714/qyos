package admin

import (
	"context"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/handler/dto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// UserAPIKeyService is the part of *service.APIKeyService the admin API key handler uses
// to create keys for a user and to change a key's status on the owner's behalf.
type UserAPIKeyService interface {
	Create(ctx context.Context, userID int64, req service.CreateAPIKeyRequest) (*service.APIKey, error)
	GetByID(ctx context.Context, id int64) (*service.APIKey, error)
	Update(ctx context.Context, id int64, userID int64, req service.UpdateAPIKeyRequest) (*service.APIKey, error)
}

var (
	// ErrAdminUserAPIKeyForbidden 管理员账号的 Key 不能经管理接口代建，避免把管理员身份交给自动化系统。
	ErrAdminUserAPIKeyForbidden = infraerrors.Forbidden("ADMIN_USER_API_KEY_FORBIDDEN", "cannot create API keys for administrator accounts")
	// ErrScopedAdminTargetForbidden 受限管理密钥不得管理管理员账号及其 Key。
	ErrScopedAdminTargetForbidden = infraerrors.Forbidden("SCOPED_ADMIN_TARGET_FORBIDDEN", "scoped admin keys cannot manage administrator accounts or their API keys")
	// ErrAPIKeyStatusConflict 只有已停用的 Key 可以恢复；过期、额度耗尽等状态须先处理根因。
	ErrAPIKeyStatusConflict = infraerrors.Conflict("API_KEY_STATUS_CONFLICT", "only disabled API keys can be re-enabled")
)

// AdminAPIKeyHandler handles admin API key management
type AdminAPIKeyHandler struct {
	adminService service.AdminService
	keyService   UserAPIKeyService
}

// NewAdminAPIKeyHandler creates a new admin API key handler
func NewAdminAPIKeyHandler(adminService service.AdminService, keyService *service.APIKeyService) *AdminAPIKeyHandler {
	h := &AdminAPIKeyHandler{adminService: adminService}
	if keyService != nil {
		h.keyService = keyService
	}
	return h
}

// AdminCreateUserAPIKeyRequest is the body of POST /api/v1/admin/users/:id/api-keys.
// Enterprise OS (os-bridge) uses it to give each employee a dedicated key without a password login.
type AdminCreateUserAPIKeyRequest struct {
	Name    string `json:"name" binding:"required"`
	GroupID *int64 `json:"group_id"`
}

// CreateForUser creates an API key owned by the given user.
// Only active, non-admin users qualify.
// POST /api/v1/admin/users/:id/api-keys
func (h *AdminAPIKeyHandler) CreateForUser(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || userID <= 0 {
		response.BadRequest(c, "Invalid user ID")
		return
	}
	var req AdminCreateUserAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 100 {
		response.BadRequest(c, "Invalid request: name must be 1-100 characters")
		return
	}
	if req.GroupID != nil && *req.GroupID <= 0 {
		req.GroupID = nil
	}
	if h.keyService == nil {
		response.InternalError(c, "API key creation is not configured")
		return
	}
	user, err := h.adminService.GetUser(c.Request.Context(), userID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	if user.IsAdmin() {
		response.ErrorFrom(c, ErrAdminUserAPIKeyForbidden)
		return
	}
	if !user.IsActive() {
		response.ErrorFrom(c, service.ErrUserNotActive)
		return
	}
	key, err := h.keyService.Create(c.Request.Context(), userID, service.CreateAPIKeyRequest{Name: req.Name, GroupID: req.GroupID})
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, dto.APIKeyFromService(key))
}

// AdminUpdateAPIKeyStatusRequest is the body of PUT /api/v1/admin/api-keys/:id/status.
type AdminUpdateAPIKeyStatusRequest struct {
	Status string `json:"status" binding:"required,oneof=active disabled"`
}

// UpdateStatus enables or disables an API key on behalf of its owner.
// The owner-side update path invalidates the key's auth cache (local L1, Redis, and pub/sub to other instances).
// PUT /api/v1/admin/api-keys/:id/status
func (h *AdminAPIKeyHandler) UpdateStatus(c *gin.Context) {
	keyID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || keyID <= 0 {
		response.BadRequest(c, "Invalid API key ID")
		return
	}
	var req AdminUpdateAPIKeyStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: status must be active or disabled")
		return
	}
	if h.keyService == nil {
		response.InternalError(c, "API key management is not configured")
		return
	}
	key, err := h.keyService.GetByID(c.Request.Context(), keyID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	if !h.scopedKeyMayManageOwner(c, key.UserID) {
		return
	}
	if key.Status == req.Status {
		response.Success(c, dto.APIKeyFromService(key))
		return
	}
	if req.Status == service.StatusActive && key.Status != service.StatusDisabled {
		response.ErrorFrom(c, ErrAPIKeyStatusConflict)
		return
	}
	status := req.Status
	updated, err := h.keyService.Update(c.Request.Context(), keyID, key.UserID, service.UpdateAPIKeyRequest{Status: &status})
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, dto.APIKeyFromService(updated))
}

// scopedKeyMayManageOwner 受限管理密钥只能管理普通用户名下的 Key；全权密钥与登录会话不受此限制。
// 返回 false 时已写入错误响应。
func (h *AdminAPIKeyHandler) scopedKeyMayManageOwner(c *gin.Context, ownerID int64) bool {
	if adminaccess.RestrictedFromContext(c.Request.Context()) == nil {
		return true
	}
	owner, err := h.adminService.GetUser(c.Request.Context(), ownerID)
	if err != nil {
		response.ErrorFrom(c, err)
		return false
	}
	if owner.IsAdmin() {
		response.ErrorFrom(c, ErrScopedAdminTargetForbidden)
		return false
	}
	return true
}

// AdminUpdateAPIKeyGroupRequest represents the request to update an API key.
type AdminUpdateAPIKeyGroupRequest struct {
	GroupID             *int64 `json:"group_id"`               // nil=不修改, 0=解绑, >0=绑定到目标分组
	ResetRateLimitUsage *bool  `json:"reset_rate_limit_usage"` // true=重置 5h/1d/7d 限速用量
}

// UpdateGroup handles updating an API key's admin-managed fields.
// PUT /api/v1/admin/api-keys/:id
func (h *AdminAPIKeyHandler) UpdateGroup(c *gin.Context) {
	keyID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "Invalid API key ID")
		return
	}

	var req AdminUpdateAPIKeyGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}

	if adminaccess.RestrictedFromContext(c.Request.Context()) != nil {
		if h.keyService == nil {
			response.InternalError(c, "API key management is not configured")
			return
		}
		key, err := h.keyService.GetByID(c.Request.Context(), keyID)
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
		if !h.scopedKeyMayManageOwner(c, key.UserID) {
			return
		}
	}

	var resetKey *service.APIKey
	if req.ResetRateLimitUsage != nil && *req.ResetRateLimitUsage {
		resetKey, err = h.adminService.AdminResetAPIKeyRateLimitUsage(c.Request.Context(), keyID)
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
	}

	result, err := h.adminService.AdminUpdateAPIKeyGroupID(c.Request.Context(), keyID, req.GroupID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	if resetKey != nil && req.GroupID == nil {
		result.APIKey = resetKey
	}

	resp := struct {
		APIKey                 *dto.APIKey `json:"api_key"`
		AutoGrantedGroupAccess bool        `json:"auto_granted_group_access"`
		GrantedGroupID         *int64      `json:"granted_group_id,omitempty"`
		GrantedGroupName       string      `json:"granted_group_name,omitempty"`
	}{
		APIKey:                 dto.APIKeyFromService(result.APIKey),
		AutoGrantedGroupAccess: result.AutoGrantedGroupAccess,
		GrantedGroupID:         result.GrantedGroupID,
		GrantedGroupName:       result.GrantedGroupName,
	}
	response.Success(c, resp)
}
