package admin

import (
	"slices"

	"github.com/Wei-Shaw/sub2api/internal/handler/dto"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

// adminUserResponse 对受限密钥使用字段白名单，避免完整管理员 DTO 新增字段时隐式扩大授权。
// 订阅及用量由各自的独立接口提供，用户资料接口不嵌入这些关联数据。
func adminUserResponse(c *gin.Context, user *service.User) any {
	principal := adminaccess.RestrictedFromContext(c.Request.Context())
	if principal == nil {
		return dto.UserFromServiceAdmin(user)
	}
	if user == nil {
		return nil
	}
	out := gin.H{"id": user.ID}
	permissions := principal.Policy.GlobalPermissions
	if slices.Contains(permissions, "users.read") {
		out["email"] = user.Email
		out["username"] = user.Username
		out["role"] = user.Role
		out["status"] = user.Status
		out["concurrency"] = user.Concurrency
		out["rpm_limit"] = user.RPMLimit
		out["last_active_at"] = user.LastActiveAt
		out["created_at"] = user.CreatedAt
		out["updated_at"] = user.UpdatedAt
		out["deleted_at"] = user.DeletedAt
	}
	if slices.Contains(permissions, "users.balance.read") {
		out["balance"] = user.Balance
		out["frozen_balance"] = user.FrozenBalance
		out["total_recharged"] = user.TotalRecharged
	}
	if slices.Contains(permissions, "groups.read") {
		out["allowed_groups"] = user.AllowedGroups
		out["restrict_public_groups"] = user.RestrictPublicGroups
		out["group_rates"] = user.GroupRates
	}
	return out
}

// ErrScopedAdminBalanceWriteRequired 受限密钥创建或编辑用户时设置余额，须另行授权 users.balance.write。
var ErrScopedAdminBalanceWriteRequired = infraerrors.Forbidden("SCOPED_ADMIN_BALANCE_WRITE_REQUIRED", "setting a user balance requires the users.balance.write permission")

// scopedAdminUserWriteAllowed 是受限密钥经 users.create / users.update 写用户时的字段边界：
// 不能创建或提升管理员、不能修改管理员账号；设置余额另需 users.balance.write。
// target 为 nil 表示创建。全权密钥与登录会话直接放行。返回 false 时已写入 403。
func scopedAdminUserWriteAllowed(c *gin.Context, target *service.User, role string, balance *float64) bool {
	principal := adminaccess.RestrictedFromContext(c.Request.Context())
	if principal == nil {
		return true
	}
	if role == service.RoleAdmin || (target != nil && target.IsAdmin()) {
		response.ErrorFrom(c, ErrScopedAdminTargetForbidden)
		return false
	}
	if balance != nil && !slices.Contains(principal.Policy.GlobalPermissions, "users.balance.write") {
		response.ErrorFrom(c, ErrScopedAdminBalanceWriteRequired)
		return false
	}
	return true
}
