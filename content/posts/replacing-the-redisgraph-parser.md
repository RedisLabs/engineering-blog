---
title: "Lessons learned while replacing the RedisGraph parser"
date: 2019-11-22
authors:
  - author:
      name: "Jeffrey Lovitz"
      link: "https://github.com/jeffreylovitz"
tags: ["redisgraph", "c", "cypher", "parser", "oss"]
---

![parser](/parser.png)

Since its inception, RedisGraph used [Flex](https://github.com/westes/flex) and [Lemon](https://www.sqlite.org/lemon.html) (a yacc-like parser generator developed by the SQLite team) to build its query parser. We maintained our own grammar, extending it to accommodate new features as we wrote them. Flex and Lemon are marvelous and valuable tools, but looking back, my take on our initial do-everything-ourselves approach is best captured by Douglas Adams:

> In the beginning the Universe was created. This has made a lot of people very angry and been widely regarded as a bad move.

[59 commits, ~20,000 modified lines](https://github.com/RedisGraph/RedisGraph/pull/488), and a few months later, we've paid back a solid amount of technical debt and learned a few things along the way! RedisGraph queries are fully converted to ASTs by [libcypher-parser](https://github.com/cleishm/libcypher-parser), an Apache-licensed project authored and maintained over the past four years by Chris Leishman (on [Twitter](https://twitter.com/cleishm) and [Github](https://github.com/cleishm/) as cleishm).

## When to repay technical debt

> The extra effort that it takes to add new features is the interest paid on the debt.

To use [Martin Fowler's language of technical debt](https://martinfowler.com/bliki/TechnicalDebt.html), our self-maintained grammar charged us interest every time we introduced or modified a syntactical construct. Gradual improvement was not an option, however, so we were reluctant to undertake the effort of a full replacement. We finally relented when working on the `WITH`clause, which is how Cypher allows for multiple queries to be chained into a single atomic execution. Unlike subqueries in SQL, which create a tree of independent executions, the `WITH` clause flattens query parts into a linear composition:

![Multi-Part Query Railroad Diagram](/MultiPartQuery.svg)
[Cypher railroad diagram for multi-part queries](https://s3.amazonaws.com/artifacts.opencypher.org/railroad/MultiPartQuery.html)

Our original grammar was effective at interpreting a sequence of clauses as a self-contained query, but it would have required a major rewrite to interpret that same sequence as one scope capable of reading from and projecting into others. libcypher-parser had already solved this problem and many more, so we started the even more ambitious rewrite of scrapping our parser and building off an open source project.

## The joy of FOSS
libcypher-parser was a perfect fit for our needs. Beyond the core criteria of being a feature-rich Cypher parser, it is a C implementation, stable but evolving, and — above all — open source.

RedisGraph is a better project for the issues opened, features requested, and contributions made by our open source users. While integrating libcypher-parser, we've contributed code and feedback upstream, and collaboration that improves both projects is ongoing.

We all know that a vibrant open source community can enrich us, but I always find it heartening to be reminded.

As an aside, it is interesting to note that instead of building a LALR parser (as Lemon does), libcypher-parser uses a PEG grammar. I won't go into the implications of this here, but Guido van Rossum has been writing a [very interesting series](https://medium.com/@gvanrossum_83706/peg-parsers-7ed72462f97c) on the subject for the curious.

## Paid back with interest
From start to finish, this undertaking took about three months, though even now we have open PRs to better leverage the new system. We now work with an immutable (though annotatable) AST, and have radically modified our access patterns and AST translation layer.

To torture the metaphor of technical debt a little more, we recouped more than the principal over the course of this refactor. libcypher-parser gave us automatic support for a number of features, ranging from syntactic sugar like implicit edges and partially-specified traversal ranges:
```console
MATCH (node1)-->(node2), (src)-[*2..]->(two_or_more_hops)
```
To more robust query validations and built-in precedence management for operators and comparisons.

We also took advantage of this moment to migrate all parsing to RedisGraph threads, so multiple queries can be parsed in parallel and the Redis server never blocks to perform this work.

## The strength of strong abstractions
Beyond these improvements, the greatest benefit of this refactor has been a much stronger abstraction layer between the AST and the tree of operations required to act upon it.

Our earlier grammar made it easy to rely directly on the AST for the construction of operations, especially in superficially simple clauses like `CREATE`. This approach belies the complexity of circumstances that need to be considered, however. For example, given the query:
```console
MATCH (p:Person {name: 'Jeffrey'})
CREATE (p)-[:EMPLOYED_BY]->(c: Company {name: 'Redis Labs'})
RETURN *
```
The `CREATE` operation does not exist in isolation—it relies on projections from previous operations and itself projects data that must be returned to the user.

Having a strong abstraction layer between the AST and the execution tree of operations allows for far easier extension as the complexity of a project increases.

RedisGraph execution plan:
```console
MATCH (p:Parser {name: 'libcypher-parser'})-[:CONSTRUCTS]->(ast) RETURN ast

Results
    Project
        Conditional Traverse | (p:Parser)->(ast)
            Filter
                Node By Label Scan | (p:Parser)
```

libcypher-parser AST:
```console
 @0   0..76  statement                body=@1
 @1   0..76  > query                  clauses=[@2, @15]
 @2   0..65  > > MATCH                pattern=@3
 @3   6..64  > > > pattern            paths=[@4]
 @4   6..64  > > > > pattern path     (@5)-[@11]-(@13)
 @5   6..43  > > > > > node pattern   (@6:@7 {@8})
 @6   7..8   > > > > > > identifier   `p`
 @7   8..15  > > > > > > label        :`Parser`
 @8  16..42  > > > > > > map          {@9:@10}
 @9  17..21  > > > > > > > prop name  `name`
@10  23..41  > > > > > > > string     "libcypher-parser"
@11  43..59  > > > > > rel pattern    -[:@12]->
@12  45..56  > > > > > > rel type     :`CONSTRUCTS`
@13  59..64  > > > > > node pattern   (@14)
@14  60..63  > > > > > > identifier   `ast`
@15  65..76  > > RETURN               projections=[@16]
@16  72..76  > > > projection         expression=@17
@17  72..75  > > > > identifier       `ast`
```

## Lessons learned
I think this captures the most important lessons I've learned (outside of my editor window) over the course of this project:

1) Recognize when the time has come to pay back technical debt.

2) Embrace what open source gives, and give everything you can back!

3) Strong abstraction layers prevent many headaches.

4) Obey the wisdom of "Don't reinvent the wheel."

5) After you inevitably fail to follow 4 (or any other axiom of programming), think twice next time!

---

[RedisGraph](https://github.com/redisgraph/redisgraph) and [libcypher-parser](https://github.com/cleishm/libcypher-parser) are both actively being developed and welcome contributors at any level! This is an exciting time in the world of graph databases and query languages, and there are lots of interesting challenges to find.
