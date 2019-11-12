---
title: "Using the Redis Allocator in Rust"
date: 2019-11-12
authors:
  - Gavrie Philipson
tags: ["redisjson", "rust"]
---

## Introduction

While developing [redis-module-rs](https://github.com/RedisLabsModules/redismodule-rs), the [Rust](https://www.rust-lang.org) API for writing [Redis modules](https://redis.io/topics/modules-intro), I encountered the need to set up a custom memory allocator.

Normally, when a Rust program needs to allocate some memory, such as when creating a `String` or `Vec` instance, it uses the [global allocator](https://doc.rust-lang.org/std/alloc/index.html) defined in the program. Since Redis modules are built as shared libraries to be loaded into Redis, Rust will use the [`System`](https://doc.rust-lang.org/std/alloc/struct.System.html) allocator, which is the default provided by the OS (using the `libc` [`malloc(3)`](https://linux.die.net/man/3/malloc) function).

This behavior is problematic for several reasons. 

First of all, Redis may not be using the system allocator at all, relying on [`jemalloc`](http://jemalloc.net) instead. The `jemalloc` allocator is an alternative to the system `malloc` that includes many tweaks to avoid fragmentation, among other features. If the module uses the system allocator and Redis uses `jemalloc`, the allocation behavior will be inconsistent.

Secondly, even if Redis were to always use the system allocator, memory allocated directly by the module would not be visible to Redis: It would not show up in commands such as [`info memory`](https://redis.io/commands/info), and would not be influenced by cleanup operations performed by Redis such as eviction of keys.

For these reasons, the [Redis Modules API](https://redis.io/topics/modules-api-ref) provides hooks such as `RedisModule_Alloc` and `RedisModule_Free`. These are used much like the standard `malloc` and `free` calls, but make Redis aware of the allocated memory in addition to actually passing the call on to the memory allocator.

## Using a Custom Allocator

Rust provides the option to define a custom memory allocator by providing a custom implementation of the [`GlobalAlloc`](https://doc.rust-lang.org/std/alloc/trait.GlobalAlloc.html) trait:

We can use it by implementing the `GlobalAlloc` trait with our own methods that delegate the allocation to Redis. For this, we need a way to call the Redis Module API functions from Rust. That is a topic for another post, but in short we achieve this by using the [`bindgen`](https://crates.io/crates/bindgen) crate to generate Rust bindings from the [`redismodule.h`](https://github.com/antirez/redis/blob/unstable/src/redismodule.h) C header file.

The header file defines the functions as follows:

```c
#define REDISMODULE_API_FUNC(x) (*x)

void *REDISMODULE_API_FUNC(RedisModule_Alloc)(size_t bytes);
void REDISMODULE_API_FUNC(RedisModule_Free)(void *ptr);
```

These functions, like the rest of the Modules API, are defined as function pointers. When calling the functions from Rust, we need to dereference the function pointer first, which we do using the `unwrap()` method. We also need to do some casting to match up the pointer types. Finally, we need to use the `unsafe` keyword since we dereference raw pointers, which is not allowed in safe Rust for good reasons:

```rust
struct RedisAlloc;

unsafe impl GlobalAlloc for RedisAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        RedisModule_Alloc.unwrap()(layout.size()) as *mut u8
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        RedisModule_Free.unwrap()(ptr as *mut c_void)
    }
}
```

Unfortunately, it's not this simple. When we build a module with this custom allocator, Redis crashes on us:

```plaintext
```


