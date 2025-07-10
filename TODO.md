# FluidInput - TODO List

> **实际需要修复的问题** (2025-07-10)

## 🔧 HIGH PRIORITY - 真正有用的改进

### 1. **统一界面语言**
- **Priority**: HIGH
- **Issue**: 权限状态信息混用中英文
- **Location**: `permission-manager.js:283-294`
- **Fix**: 将中文改为英文
- **Status**: 简单文本替换

### 2. **改进录音状态反馈**
- **Priority**: HIGH  
- **Issue**: 用户不清楚录音/处理/完成状态
- **Location**: `input-prompt.html`
- **Fix**: 
  - 显示录音时长
  - 更清晰的状态提示
  - 延长转录结果显示时间

### 3. **允许用户自定义快捷键**
- **Priority**: HIGH
- **Issue**: 快捷键硬编码为Ctrl+Shift，应该让用户可以设置
- **Location**: `settings.html`, `main.js`
- **Fix**: 在设置中添加快捷键选择器

### 4. **修复硬编码用户名**
- **Priority**: HIGH  
- **Issue**: 主窗口显示硬编码的"Tao"用户名
- **Location**: `main.html`
- **Fix**: 移除或改为通用欢迎信息

## 📱 MEDIUM PRIORITY - 界面优化

### 5. **修复主窗口品牌信息**
- **Priority**: MEDIUM  
- **Issue**: 显示"Flow"而不是"FluidInput"
- **Location**: `main.html`
- **Fix**: 更新文本内容为正确的应用名称

### 6. **清理无用的设置选项**
- **Priority**: MEDIUM
- **Issue**: 设置界面有很多不工作的假功能（Account, Team, Billing等）
- **Location**: `settings.html:224-242`  
- **Fix**: 删除不工作的选项卡

## 🔧 LOW PRIORITY - 锦上添花

### 7. **添加录音时长显示**
- **Priority**: LOW
- **Issue**: 用户不知道录音了多长时间
- **Fix**: 在录音界面添加计时器

### 8. **改进多显示器支持**
- **Priority**: LOW
- **Issue**: 录音窗口位置计算在多显示器下可能有问题
- **Location**: `main.js:94-108`
- **Fix**: 更好的主显示器检测逻辑

---

## 🎯 修复顺序

### **立刻搞定** (30分钟)
1. 统一界面语言 
2. 修复硬编码用户名
3. 清理设置界面无用选项

### **有空再搞** 
4. 改进录音状态反馈
5. 用户自定义快捷键
6. 其他优化