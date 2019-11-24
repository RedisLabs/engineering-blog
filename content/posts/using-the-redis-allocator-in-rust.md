---
title: "Using the Redis Allocator in Rust"
date: 2019-11-12
authors:
  - author: 
      name: Gavrie Philipson
      link: https://github.com/gavrie
tags: ["redisjson", "rust"]
---

## Introduction

While developing [redismodule-rs](https://github.com/RedisLabsModules/redismodule-rs), the [Rust](https://www.rust-lang.org) API for writing [Redis modules](https://redis.io/topics/modules-intro), I encountered the need to set up a custom memory allocator.

Normally, when a Rust program needs to allocate some memory, such as when creating a `String` or `Vec` instance, it uses the [global allocator](https://doc.rust-lang.org/std/alloc/index.html) defined in the program. Since Redis modules are built as shared libraries to be loaded into Redis, Rust will use the [`System`](https://doc.rust-lang.org/std/alloc/struct.System.html) allocator, which is the default provided by the OS (using the `libc` [`malloc(3)`](https://linux.die.net/man/3/malloc) function).

This behavior is problematic for several reasons. 

First of all, Redis may not be using the system allocator at all, relying on [`jemalloc`](http://jemalloc.net) instead. The `jemalloc` allocator is an alternative to the system `malloc` that includes many tweaks to avoid fragmentation, among other features. If the module uses the system allocator and Redis uses `jemalloc`, the allocation behavior will be inconsistent.

Secondly, even if Redis always used the system allocator, memory allocated directly by the module would not be visible to Redis: it would not show up in commands such as [`info memory`](https://redis.io/commands/info), and would not be influenced by cleanup operations performed by Redis such as eviction of keys.

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
use std::alloc::{GlobalAlloc, Layout};
use std::os::raw::c_void;

struct RedisAlloc;

unsafe impl GlobalAlloc for RedisAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        RedisModule_Alloc.unwrap()(layout.size()) as *mut u8
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        RedisModule_Free.unwrap()(ptr as *mut c_void)
    }
}
```

## The Crash

Unfortunately, it's not that simple. When we build a module with this custom allocator and load it into Redis, it crashes on us. Redis does print a nice stack trace when it crashes, so let's look at it:

```plaintext

$ redis-server --loadmodule ./target/debug/examples/libhello.dylib
thread panicked while processing panic. aborting.
...
Backtrace:
0   redis-server                        0x000000010adce1dc logStackTrace + 110
1   redis-server                        0x000000010adce562 sigsegvHandler + 236
2   libsystem_platform.dylib            0x00007fff5b95db3d _sigtramp + 29
3   ???                                 0x0000000000000000 0x0 + 0
4   libhello.dylib                      0x000000010af5af6d _ZN3std9panicking18continue_panic_fmt17h0e74ab2b215a1401E + 157
5   libhello.dylib                      0x000000010af5ae69 rust_begin_unwind + 9
6   libhello.dylib                      0x000000010af6ea3f _ZN4core9panicking9panic_fmt17h09741a3213dba543E + 63
7   libhello.dylib                      0x000000010af6e984 _ZN4core9panicking5panic17hb4bc64e7f35c9151E + 100
8   libhello.dylib                      0x000000010af53108 _ZN4core6option15Option$LT$T$GT$6unwrap17h66957b4d942a4d3cE + 56
9   libhello.dylib                      0x000000010af4f8f3 _ZN76_$LT$redis_module..alloc..RedisAlloc$u20$as$u20$core..alloc..GlobalAlloc$GT$5alloc17h6588ea2d7520a3ebE + 35
...
```

So, it looks like we had a null pointer dereference here (`3 ??? 0x0000000000000000 0x0 + 0`), but what are all these weird symbols starting with `_ZN...`?

After a bit of searching, we find that this is the way Rust does name mangling: Unlike in C, and similarly to C++, in Rust multiple functions with the same name can coexist, since there are various namespace mechanisms such as modules and traits to distinguish them. To generate unique symbols that are C-compatible, the compiler mangles these to long and ugly unique names. To demangle these names back into the original, we can filter the output through [`rustfilt`](https://crates.io/crates/rustfilt). 

This gives us the following stack trace (uninteresting parts removed):

```plaintext
3   ???                                 0x0000000000000000 0x0 + 0
...
31  libhello.dylib                      0x000000010af6e984 core::panicking::panic + 100
32  libhello.dylib                      0x000000010af53108 core::option::Option<T>::unwrap + 56
33  libhello.dylib                      0x000000010af4f8f3 <redis_module::alloc::RedisAlloc as core::alloc::GlobalAlloc>::alloc + 35
34  libhello.dylib                      0x000000010af4cc8c __rg_alloc + 60
35  libhello.dylib                      0x000000010af6e2f6 <alloc::vec::Vec<u8> as core::convert::From<&str>>::from + 38
36  libhello.dylib                      0x000000010af4de54 <T as core::convert::Into<U>>::into + 36
37  libhello.dylib                      0x000000010af4f57f std::ffi::c_str::CString::new + 47
38  libhello.dylib                      0x000000010af40daa RedisModule_OnLoad + 58
39  redis-server                        0x000000010adf97d9 moduleLoad + 118
40  redis-server                        0x000000010adf9735 moduleLoadFromQueue + 69
41  redis-server                        0x000000010ad94428 main + 1190
...
```

It still took me a lot head-scratching and experimenting to figure it out, but here's what happened:

The functions of the Redis modules API are accessed via C function pointers. Instead of relying on the dynamic linker to initialize these pointers, they are initialized explicitly by Redis as part of module initialization process.

As the stack trace shows, during the loading of the module we call the `CString::new` function. This standard library function allocates memory for a string. This, in turn, calls our allocator which would then call `RedisModule_Alloc.unwrap()...` to actually perform the allocation. This causes a chicken-and-egg problem. The Redis module is not ready yet, meaning our function pointers have not yet been initialized, so we can't call the relevant API to perform the allocation.

## The Solution

I try various approaches to solve this, but there seems to be no clean way to avoid the allocation during module initialization. The second best thing would be to use the standard allocator until the module is ready, and then switch to the custom one. However, Rust doesn't allow changing the allocator at runtime so we can't do that.

I end up adding a flag to the custom allocator that causes allocations to be passed through to the system allocator at startup. After the module initialization is complete, the flag is toggled so that further allocations are then performed via the Redis allocator. This solution still has edge cases—most importantly requiring that all previously allocated memory is freed before switching, otherwise that memory would leak. However, it's good enough for our purposes.

Here is what the final code looks like:

```rust
use ...;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

pub struct RedisAlloc;

static USE_REDIS_ALLOC: AtomicBool = AtomicBool::new(false);

unsafe impl GlobalAlloc for RedisAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let use_redis = USE_REDIS_ALLOC.load(SeqCst);
        if use_redis {
            return raw::RedisModule_Alloc.unwrap()(layout.size()) as *mut u8;
        }
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let use_redis = USE_REDIS_ALLOC.load(SeqCst);
        if use_redis {
            return raw::RedisModule_Free.unwrap()(ptr as *mut c_void);
        }
        System.dealloc(ptr, layout);
    }
}

pub fn use_redis_alloc() {
    USE_REDIS_ALLOC.store(true, SeqCst);
    eprintln!("Now using Redis allocator");
}
```

We add a `static` flag named `USE_REDIS_ALLOC` that determines whether we should use the Redis allocator or the system one. It's important to guarantee safety when mutating static data, so we use an `AtomicBool` here that is `false` by default.

In the module initialization code, we call `use_redis_alloc` when the module is ready to use. At this point we can safely start using the Redis allocator, and all future allocations will be accounted for by Redis.

This takes care of the crash and ends up in the [`redis-module`](https://crates.io/crates/redis-module) crate. Feel free to check it out and let me know how you like it!
