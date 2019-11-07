# If you think goto is a bad idea, what would you say about longjmp?


I honestly disagree with the conventional wisdom of never using a `goto` in your code. There are several situations where I find it to be not just convenient, but good practice. the most common case is `goto cleanup`. Consider the following:

<iframe src="https://medium.com/media/4ad142d0359de0417333be222261d25b" frameborder=0></iframe>

<iframe src="https://medium.com/media/224c5e983135c4735506719377086f49" frameborder=0></iframe>

Instead of keeping tabs after which pointers need to be freed whenever a condition is met, we simply jump, free whatever was allocated, and return. In my eyes this design is cleaner and less prone to error, but I can understand why others are against it.

Recently, we (the [RedisGraph](https://oss.redislabs.com/redisgraph/) team) wanted to introduce error reporting to handle failures while evaluating expressions. For example, evaluating the static expression `toUpper(5)` would fail as the `toUpper` function expects its argument to be a string. If this assumption isn't met, `toUpper` should raise an exception:

<iframe src="https://medium.com/media/e1a7b4062927f76d1e797403ad922856" frameborder=0></iframe>

Unfortunately, C doesn't come with a built-in exceptions mechanism like many other high-level languages do.

<iframe src="https://medium.com/media/0ea4e27e47a23c849324f17ff684db35" frameborder=0></iframe>

What we were after is a `try catch` logic:

<iframe src="https://medium.com/media/50a574d0215fd8a67279d99f82a4b374" frameborder=0></iframe>

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

<iframe src="https://medium.com/media/02bd00f143d56e761f67c08aebd432f6" frameborder=0></iframe>

Another idea we had was calling `ExecutionPlan_Execute` within a new thread, such that when an exception was thrown we would simply terminate the thread and resume execution within the "parent" thread. This approach would have save us the need to introduce extra logic or code branching:

<iframe src="https://medium.com/media/cec5d101ad6bdfeedfa82acb6e2d05ce" frameborder=0></iframe>

But this design would introduce an overhead of additional thread execution (even if we were to use a thread-pool), and we didn’t want to give up too much control to the OS scheduler.

Ultimately, we found out about `longjmp`, which is similar to `jump` but not restricted in scope to the caller function. We can simply jump from anywhere to a preset point somewhere else in our call stack, and the best part is our stack would unwind to that point as if we've returned from each nested function. kinda going back in time if you will.

<iframe src="https://medium.com/media/d33b98f38bdb100f6a91ac98840198c9" frameborder=0></iframe>

This is the design we’ve introduced recently. In case you ever run a query in [RedisGraph](https://github.com/RedisGraph/RedisGraph) which violates the assumptions of a called function, this mechanism will be used to report an error back.

    127.0.0.1:6379> GRAPH.query G "match (a:person) where toUpper(a.name) = 'Alexander' RETURN a"
    (error) Type mismatch: expected String but was Integer

Error reporting RedisGraph via redis-cli.

Out of curiosity I searched [cpython github repository](https://github.com/python/cpython) (Python implementation) to see if there's a reference for `longjmp`. I was wondering if they've applied the same approach to exception handling as we did, but [my search](https://github.com/python/cpython/search?q=longjmp&unscoped_q=longjmp) came out with no results - I'll have to investigate further.
