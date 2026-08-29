use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Registry of per-operation cancel tokens.
/// Each install operation gets a unique key; setting the flag cancels it.
pub struct InstallCancelRegistry {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for InstallCancelRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl InstallCancelRegistry {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new operation and return its cancel flag.
    pub fn register(&self, key: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        self.tokens
            .lock()
            .unwrap()
            .insert(key.to_string(), token.clone());
        token
    }

    /// 复用已存在的停止令牌，使早于任务注册到达的停止请求不会丢失。
    pub fn register_or_get(&self, key: &str) -> Arc<AtomicBool> {
        let mut tokens = self.tokens.lock().unwrap();
        tokens
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// 设置停止令牌；任务尚未注册时先保留请求。
    pub fn cancel_or_register(&self, key: &str) {
        let token = self.register_or_get(key);
        token.store(true, Ordering::SeqCst);
    }

    /// Signal cancellation for the given operation.
    pub fn cancel(&self, key: &str) -> bool {
        if let Some(token) = self.tokens.lock().unwrap().get(key) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Remove a completed/cancelled operation from the registry.
    pub fn remove(&self, key: &str) {
        self.tokens.lock().unwrap().remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_returns_false_token() {
        let registry = InstallCancelRegistry::new();
        let token = registry.register("op-1");
        assert!(!token.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_sets_token_to_true() {
        let registry = InstallCancelRegistry::new();
        let token = registry.register("op-1");
        assert!(registry.cancel("op-1"));
        assert!(token.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_unknown_key_returns_false() {
        let registry = InstallCancelRegistry::new();
        assert!(!registry.cancel("nonexistent"));
    }

    #[test]
    fn remove_cleans_up_token() {
        let registry = InstallCancelRegistry::new();
        registry.register("op-1");
        registry.remove("op-1");
        assert!(!registry.cancel("op-1"));
    }

    #[test]
    fn multiple_operations_independent() {
        let registry = InstallCancelRegistry::new();
        let t1 = registry.register("op-1");
        let t2 = registry.register("op-2");

        registry.cancel("op-1");
        assert!(t1.load(Ordering::SeqCst));
        assert!(!t2.load(Ordering::SeqCst));
    }

    #[test]
    fn register_same_key_replaces_token() {
        let registry = InstallCancelRegistry::new();
        let old = registry.register("op-1");
        let new = registry.register("op-1");

        // Cancelling affects the new token
        registry.cancel("op-1");
        assert!(new.load(Ordering::SeqCst));
        // Old token is no longer tracked (but its Arc still exists)
        assert!(!old.load(Ordering::SeqCst));
    }

    #[test]
    fn pending_cancel_is_preserved_when_operation_registers_after_the_request() {
        let registry = InstallCancelRegistry::new();

        registry.cancel_or_register("batch-1");
        let token = registry.register_or_get("batch-1");

        assert!(token.load(Ordering::SeqCst));
    }
}
