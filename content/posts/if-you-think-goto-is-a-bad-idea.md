---
title: "If you think goto is a bad idea, what would you say about longjmp?"

date: 2019-11-07T17:46:51+02:00
draft: true
---

![goto](/goto.png)

I honestly disagree with the conventional wisdom of never using a `goto` in your code. There are several situations where I find it to be not just convenient, but good practice. the most common case is `goto cleanup`. Consider the following:

Without `goto`:

```
void f(void) {
	void *a = NULL;
	void *b = NULL;
	void *c = NULL;
  
	a = malloc(32);
	//...
	if(cond1) {
		free(a)
		return;
	}
  
	b = malloc(64);
	//...
	if(cond2) {
		free(a);
		free(b);
		return;
	}
  
	c = malloc(128);  
	//...
	free(a);
	free(b);
	free(c);
}
```

With `goto`:

```
void f(void) {
  	void *a = NULL;
	void *b = NULL;
	void *c = NULL;

	a = malloc(32);
	//...
	if(cond1) goto cleanup;

	b = malloc(64);
  	//...
	if(cond2) goto cleanup;
  
	c = malloc(128);
	//...
cleanup:
	if(a) free(a);
	if(b) free(b);
	if(c) free(c);
}
```

Instead of keeping tabs after which pointers need to be freed whenever a condition is met, we simply jump, free whatever was allocated, and return. In my eyes this design is cleaner and less prone to error, but I can understand why others are against it.

Recently, we (the [RedisGraph](https://oss.redislabs.com/redisgraph/) team) wanted to introduce error reporting to handle failures while evaluating expressions. For example, evaluating the static expression `toUpper(5)` would fail as the `toUpper` function expects its argument to be a string. If this assumption isn't met, `toUpper` should raise an exception:

```
SIValue toUpper(SIValue v) {
  SIType actual_type = SI_TYPE(v);
  if(actual_type != SI_STRING) {
    const char *actual_type_str = SIType_ToString(actual_type);
    raise("Type mismatch: expected string but was %s", actual_type_str);
  }
}
```

Unfortunately, C doesn't come with a built-in exceptions mechanism like many other high-level languages do.

```
if(cond) {
	raise Exception("something went wrong")
}
```

What we were after is a `try catch` logic:

```
try {
  // Perform work which might throw an exception
  work();
} catch (error *e) {
  reportError(e);
}
```

A nice thing about this design is that regardless of where an exception was thrown within the execution path taken by our call to work, the stack is automatically restored and we resume execution within the catch block.

The function work in our case is replaced by a call to `ExecutionPlan_Execute`, which actually evaluates a query execution plan. From this point onwards we must be prepared to encounter exceptions, but the road which `ExecutionPlan_Execute` takes in unwinding and deep, consider the following call stack:

```
redisgraph.so!QueryCtx_SetError (./src/query_ctx.c:78)
redisgraph.so!_AR_EXP_ValidateInvocation (./src/arithmetic/arithmetic_expression.c:220)
redisgraph.so!_AR_EXP_Evaluate (Unknown Source:0)
redisgraph.so!AR_EXP_Evaluate (./src/arithmetic/arithmetic_expression.c:327)
redisgraph.so!_cache_records (./src/execution_plan/ops/op_value_hash_join.c:136)
redisgraph.so!ValueHashJoinConsume (./src/execution_plan/ops/op_value_hash_join.c:201)
redisgraph.so!ProjectConsume (./src/execution_plan/ops/op_project.c:67)
redisgraph.so!SortConsume (./src/execution_plan/ops/op_sort.c:169)
redisgraph.so!ResultsConsume (./src/execution_plan/ops/op_results.c:34)
redisgraph.so!ExecutionPlan_Execute (./src/execution_plan/execution_plan.c:959
```

Execution call stack.

The exception was raised way up the stack, in this case we want to:

1. abort execution, unroll 9 frames down all the way back to `ExecutionPlan_Execute`

1. enter the catch block

We could have introduce a check for error within each function on our execution path, but by doing so we would hurt performance (branch prediction) and overcomplicate our code with `if(error) return error`; logical constructs all over the place.

And so `jump` is the first option which comes to mind, but note `jump` can only jump into a location within the function it is called in.

```
function A() {
	jump there;	// Can't jump outside of current scope.
}

function B() {
there:
	...
}
```

Another idea we had was calling `ExecutionPlan_Execute` within a new thread, such that when an exception was thrown we would simply terminate the thread and resume execution within the "parent" thread. This approach would have save us the need to introduce extra logic or code branching:

```
function Query_Execute() {
	/* Call ExecutionPlan_Execute on a different thread 
	 * and wait for it to exit */
	char *error = NULL;
	pthread_t thread;
	pthread_create(&thread, NULL, ExecutionPlan_Execute, NULL);
	pthread_join(thread, &error);
	
	if(error != NULL) {
		// Exception been thrown.
		reportError(error);
	}
	...
}
```

But this design would introduce an overhead of additional thread execution (even if we were to use a thread-pool), and we didn’t want to give up too much control to the OS scheduler.

Ultimately, we found out about `longjmp`, which is similar to `jump` but not restricted in scope to the caller function. We can simply jump from anywhere to a preset point somewhere else in our call stack, and the best part is our stack would unwind to that point as if we've returned from each nested function. kinda going back in time if you will.

```
// ExecutionPlan.c
function Query_Execute() {
	/* Set an exception-handling breakpoint to capture run-time errors.
	 * encountered_error will be set to 0 when setjmp is invoked, and will be nonzero if
	 * a downstream exception returns us to this breakpoint. */
	QueryCtx *ctx = pthread_getspecific(_tlsQueryCtxKey);
	if(!ctx->breakpoint) ctx->breakpoint = rm_malloc(sizeof(jmp_buf));
	int encountered_error = setjmp(*ctx->breakpoint);
  
	if(encountered_error) {
		// Encountered a run-time error; return immediately.
		reportError();
		return;
	}
	
	/* Start executing, if an exception is thrown somewhere down the road
	 * we will resume execution at: if(encountered_error) above. */
	ExecutionPlan_Execute();
}

/* ArithmeticExpression.c
 * AR_EXP_Evaluate is called from various points in our code base 
 * all originating from Query_Execute. */
SIValue AR_EXP_Evaluate(AR_ExpNode *root, const Record r) {
	SIValue result;
	AR_EXP_Result res = _AR_EXP_Evaluate(root, r, &result);
	if(res != EVAL_OK) {
		/* An error was encountered during evaluation!
		 * Exit this routine and return to the point on the stack where the handler was
		 * instantiated. */
		jmp_buf *env = _QueryCtx_GetExceptionHandler();
		longjmp(*env, 1);
	}
	return result;
}
```

This is the design we’ve introduced recently. In case you ever run a query in [RedisGraph](https://github.com/RedisGraph/RedisGraph) which violates the assumptions of a called function, this mechanism will be used to report an error back.

    127.0.0.1:6379> GRAPH.query G "match (a:person) where toUpper(a.name) = 'Alexander' RETURN a"
    (error) Type mismatch: expected String but was Integer

Error reporting RedisGraph via redis-cli.

Out of curiosity I searched [cpython github repository](https://github.com/python/cpython) (Python implementation) to see if there's a reference for `longjmp`. I was wondering if they've applied the same approach to exception handling as we did, but [my search](https://github.com/python/cpython/search?q=longjmp&unscoped_q=longjmp) came out with no results - I'll have to investigate further.
