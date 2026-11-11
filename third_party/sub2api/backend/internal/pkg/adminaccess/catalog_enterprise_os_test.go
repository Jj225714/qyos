package adminaccess

import "testing"

// 企业目录同步（os-bridge）所需的用户与 API Key 权限：均为全站权限，逐条精确登记，互不隐含。
func TestEnterpriseDirectorySyncPermissions(t *testing.T) {
	expected := map[string][]string{
		"users.create":          {"POST /users"},
		"users.update":          {"PUT /users/:id"},
		"users.api_keys.read":   {"GET /users/:id/api-keys"},
		"users.api_keys.create": {"POST /users/:id/api-keys"},
		"api_keys.group.write":  {"PUT /api-keys/:id"},
		"api_keys.status.write": {"PUT /api-keys/:id/status"},
	}
	catalog := map[string]Permission{}
	for _, entry := range PermissionCatalog() {
		if _, dup := catalog[entry.ID]; dup {
			t.Fatalf("权限重复登记: %s", entry.ID)
		}
		catalog[entry.ID] = entry
	}
	allRoutes := map[string]bool{}
	for _, routes := range expected {
		for _, route := range routes {
			allRoutes[route] = true
		}
	}
	for id, routes := range expected {
		entry, ok := catalog[id]
		if !ok {
			t.Errorf("权限未登记: %s", id)
			continue
		}
		if entry.Scope != "global" || entry.Label == "" || entry.Category == "" {
			t.Errorf("%s 应为带标签与分类的全站权限: %+v", id, entry)
		}
		p := Policy{GlobalPermissions: []string{id}}
		if err := ValidatePolicy(p); err != nil {
			t.Errorf("%s: %v", id, err)
		}
		if err := ValidatePolicy(Policy{Rules: []Rule{{Permissions: []string{id}, AllGroups: true, AccountTypes: []string{"oauth"}}}}); err == nil {
			t.Errorf("%s 不得作为账户/分组规则权限", id)
		}
		own := map[string]bool{}
		for _, route := range routes {
			own[route] = true
			method, path := splitRoute(route)
			if !RouteAllowed(p, method, "/api/v1/admin"+path) {
				t.Errorf("%s 无法进入 %s", id, route)
			}
		}
		// 不得顺带放行同组其他路由或同路径的其他方法。
		for route := range allRoutes {
			if own[route] {
				continue
			}
			method, path := splitRoute(route)
			if RouteAllowed(p, method, "/api/v1/admin"+path) {
				t.Errorf("%s 不应放行 %s", id, route)
			}
		}
		for _, route := range []string{"DELETE /users/:id", "GET /users", "GET /users/:id", "POST /users/:id/balance", "DELETE /api-keys/:id"} {
			method, path := splitRoute(route)
			if RouteAllowed(p, method, "/api/v1/admin"+path) {
				t.Errorf("%s 不应放行 %s", id, route)
			}
		}
	}
	if RouteAllowed(Policy{GlobalPermissions: []string{"users.read"}}, "POST", "/api/v1/admin/users/:id/api-keys") {
		t.Fatal("旧的只读策略不得继承新增写权限")
	}
}

func splitRoute(route string) (string, string) {
	for i, c := range route {
		if c == ' ' {
			return route[:i], route[i+1:]
		}
	}
	return route, ""
}
