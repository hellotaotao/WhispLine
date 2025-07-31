# Permission Manager 架构重构设计

## 问题分析

当前的 `permission-manager.js` 存在以下问题：
1. 单一类处理两种完全不同的环境（主进程 vs 渲染进程）
2. 每个方法都需要重复的环境检查 `if (!this.isMainProcess)`
3. 违反了单一职责原则
4. 代码冗余和复杂性过高

## 新架构设计

### 1. 分离为两个专门的类

```javascript
// 主进程权限管理器
class MainProcessPermissionManager {
  // 只处理主进程的权限管理
  // - Accessibility permissions (systemPreferences)
  // - System-level microphone permissions (systemPreferences)
}

// 渲染进程权限管理器  
class RendererPermissionManager {
  // 只处理渲染进程的权限管理
  // - Browser microphone permissions (navigator.mediaDevices)
  // - Media stream creation
  // - Permission change listeners
}
```

### 2. 工厂函数自动选择正确的实现

```javascript
function createPermissionManager() {
  const isMainProcess = typeof window === 'undefined' && 
                       typeof process !== 'undefined' && 
                       process.type === 'browser';
  
  if (isMainProcess) {
    return new MainProcessPermissionManager();
  } else {
    return new RendererPermissionManager();
  }
}
```

### 3. 文件结构

```
src/
├── permission-managers/
│   ├── main-process-permission-manager.js
│   ├── renderer-permission-manager.js
│   └── index.js (工厂函数)
```

## 优势

1. **单一职责**：每个类只负责一种环境的权限管理
2. **消除重复检查**：不需要在每个方法中检查环境
3. **更清晰的API**：每个类的方法都专注于其环境
4. **更好的测试性**：可以独立测试每个环境的逻辑
5. **更容易维护**：修改一个环境的逻辑不会影响另一个

## 实现计划

1. 创建 `MainProcessPermissionManager` 类
   - 包含所有 accessibility 和 system microphone 方法
   - 移除环境检查代码

2. 保持 `RendererPermissionManager` 类  
   - 保留原有的渲染进程功能
   - 移除环境检查代码

3. 创建工厂函数
   - 自动检测环境并返回正确的实例

4. 更新 main.js
   - 使用工厂函数创建 permission manager

## 向后兼容性

通过工厂函数，现有的使用方式保持不变：
```javascript
const permissionManager = createPermissionManager();
await permissionManager.checkAccessibilityPermissions(); // 只在主进程可用
```

这种设计消除了所有重复的环境检查，使代码更清洁、更易维护。