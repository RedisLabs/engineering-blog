---
title: "Redis-Assisted Client-Side Caching in Python"
date: 2020-01-01
authors:
  - author:
      name: "Itamar Haber"
      link: "https://twitter.com/itamarhaber"
tags: ["caching", "client", "python"]
---

<script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
<script type="text/javascript" src="/client-side-cache-chart.js"></script>

Everybody knows that there are only two hard problems in computer science: cache invalidation and naming things. This post, as you can guess from its name, is about dealing with the first hard problem. The reason I wrote it is because of a new feature in Redis v6 that makes it easier for clients to manage a local cache. This mini-project's source files can be found in the [rsacsc-py](https://github.com/itamarhaber/rsacsc-py) repository.

## Preface
This post isn't about the need for caching per se. We all cache data to reduce the time it takes us to access it subsequently. We cache on oh-so-many levels, will continue to do so until someone finally cracks [instantaneous communication](https://phys.org/news/2019-12-chip-to-chip-quantum-teleportation-harnessing-silicon.amp), and probably also afterwards. It is a necessity, evil as it may be.

Redis is a [remote server](https://redis.io/topics/faq#what-does-redis-actually-mean), meaning any data in it is accessible over the network. From the perspective of a Redis client, network-induced latency is usually the biggest contributor to overall latency. Avoiding repetitive calls by caching previous replies can mitigate that.

The data model used by Redis is that of a key-value store, an abstraction that maps a unique identifier to each data structure and the data in it. Because data access is always by key name, a Redis client can trivially store its respective data locally for caching purposes. But by doing so we arrive at the hard problem of invalidating that cache.

The aptly-named [Server-assisted client-side caching](https://redis.io/topics/client-side-caching) is a new capability added by [Redis version 6](https://raw.githubusercontent.com/antirez/redis/6.0/00-RELEASENOTES). It is intended to assist the management of a local cache by having the server send invalidation notifications. When used, the server tracks the keys accessed by a client and notifies the client when these change.

Because Redis Server-Assisted Client-Side Caching (RSACSC) is still somewhat ["immature"](http://antirez.com/news/131) in the first release candidate, I wanted to take it out for test drive. To see how it works in practice I decided to try using it. The idea was to make a proof of concept to get a better feeling for what's there and what's still missing.

## Design notes
I was already leaning towards doing this in Python, and a short [informal poll](https://twitter.com/itamarhaber/status/1207773964648550403) had provided the support for my natural inclinations. This post isn't about Python, but among the things I like in it are its readability and that it is robust enough (standard libraries and external packages) to have anything I could possibly need.

The setup I had in mind is made of three parts: 1) a connection to Redis to read data; 2) a cache to keep the data local; 3) a manager to tie everything nicely together. For making the connection, while there are quite a few [Pythonic Redis clients](https://redis.io/clients#python), I'm most comfortable with [redis-py](https://github.com/andymccurdy/redis-py). It provides the convenient `Redis` class that is a straight-forward zero-fuss client, and the Python's nature makes extending it easy.

The requirements from the cache component are basic, so I was perfectly happy adapting the [LRU example in Python's `OrederedDict` documentation](https://docs.python.org/3/library/collections.html#ordereddict-examples-and-recipes).

## Making a regular connection into a cached one
For this experiment's scope I chose to implement caching for a single Redis command, namely [`GET`](https://redis.io/commands/get). The premise is making the client use the _read through_ pattern, that is attempt a read from the local cache and defer to Redis in case of a miss. Subclassing the `Redis` client and overriding its `get` method gives us the following:

```python
class Redis(redis.Redis):
    def __init__(self, manager, *args, **kwargs):
        super().__init__(self, *args, **kwargs)
        self._manager = manager
        self._client_id = super().client_id()
        self.execute_command('CLIENT', 'TRACKING', 'ON',
            'redirect', self._manager.client_id)

    def get(self, name):
        try:
            value = self._manager.cache[name]
        except KeyError:
            value = super().get(name)
            self._manager.cache[name] = value
        return value
```

The new `Redis` class initialization is nothing too fancy, beginning by calling its base class' `__init__()` and setting a couple of properties. It ends with a call to Redis' [`CLIENT TRACKING` command], with which it enables the server's assistance for the connection.

The class' `get()` method is where the magic happens. We try to read the key's value, by name, from the cache that's available through the connection's manager. In case of `KeyError`, or a cache miss, we revert to the base class' `get()` to fetch the data and store it in the cache.

## Tracking keys in the client
Once the Redis client had opted-into being tracked, the server maintains a record of keys that the client had read from. Instead of tracking every individual key, Redis uses a hashing function on the keys' names to assign them to slots. Specifically, it uses the 24 least significant bits of the key name's CRC64 digest, resulting to roughly 16 million possible slots.

This is done to reduce the resources required by the server to track multiple keys for multiple clients. The invalidation messages sent by Redis, therefore, consist of slots that need to be invalidated rather than key names. It is up to the client to infer the relevant key names that need to be removed from its cache given the slot.

That means that, in the client, we need to employ the same hashing function to keep track of how the keys in our local cache map to slots. By doing so, we will be able to perform slot-based invalidation of the client's cache when an invalidation notification arrives. For that, we'll use the `add()` and `discard()` methods when keys are added and discarded from the local cache, respectively.

```python
    def slot(key):
        ''' Returns the slot for a key '''
        crc = crc64(key)
        crc %= 16777216
        return crc

    def add(self, key):
        ''' Adds a key to the internal tracking table '''
        slot = self.slot(key)
        self.slots[slot].add(key)

    def discard(self, key):
        ''' Removes a key from the internal tracking table '''
        slot = self.slot(key)
        self.slots[slot].discard(key)
```

# Handling invalidation
The manner in which an invalidation message is sent to a tracked client depends on the [Redis Serialization Protocol (RESP)](https://redis.io/topics/protocol) that the client is using. Earlier versions including v6 use RESP2, but its successor [RESP3](https://github.com/antirez/RESP3/blob/master/spec.md) is already present in the new version and will deprecate the older protocol completely in version 7.

RESP3 packs quite a lot of feature. One of these is the server's ability to "push" additional information on an existing connection to a client, alongside the actual replies. This channel is the one that's employed for delivering invalidation notifications when using the server-assisted client-side caching ability.

However. With RESP3 being so nascent, there are only so many (3 if I remember correctly) clients that support it presently. That effectively makes it impossible to use at the moment, so RSACSC can be used with RESP2 as well. Because RESP2 lacks the "push" ability, invalidation messages are broadcasted to interested parties using the existing support for [PubSub](https://redis.io/topics/pubsub) in Redis.

Handling the invalidations and the keys-to-slots mapping is what the manager is for. Here's how it looks like:

```python
class Manager(object):
    def __init__(self, pool, capacity=128):
        self.pool = pool
        self.capacity = capacity
        self.client_id = None
        self.client = redis.Redis(connection_pool=self.pool)
        self.slots = defaultdict(set)
        self.cache = Cache(self, maxsize=self.capacity)
        self.start()

    def start(self):
        ''' Starts the manager '''
        self.client_id = self.client.client_id()
        self._pubsub = self.client.pubsub(ignore_subscribe_messages=True)
        self._pubsub.subscribe(**{'__redis__:invalidate': self._handler})
        self._thread = self._pubsub.run_in_thread()
```

The manager is initialized with a connection pool, from which it creates its own client for PubSub as well as any subsequent cached connections requested by the using application. It also maintains a dictionary called `slots` that maps a slot number to the set of key names that it holds. Lastly, it maintains the `Cache` class that is the LRU cache's implementation.

The `start()` method is what, well, effectively starts the manager by beginning to listen to the `__redis__:invalidate` PubSub channel in a separate thread. The messages intercepted on that channel are handled by the `_handler()` method. It, in turn, calls the `invalidate()` method to invalidate the requested slot:

```python
    def _handler(self, message):
        ''' Handles invalidation messages '''
        slot = message['data']
        self.invalidate(slot)

    def invalidate(self, slot):
        ''' Invalidates a slot's keys '''
        slot = int(slot)
        while self.slots[slot]:
           key = self.slots[slot].pop()
           del self.cache[key]
```

Invalidation is just a matter of popping keys, one by one, from the respective slot's set and deleting them from the cache. Lastly, the manager exposes a factory method, `get_connection()` that's used by the code for getting new cached connections:

```python
    def get_connection(self, *args, **kwargs):
        ''' Returns a cached Redis connection '''
        conn = CachedRedis(self, connection_pool=self.pool, *args, **kwargs)
        return conn
```

## Some measurements
This post isn't about benchmarking or Python's performance per se, but it wouldn't be worth much without at least some experimental data that demonstrates the mechanism's impact. For that purpose, I've used the [benchmark.py](https://github.com/itamarhaber/rsacsc-py/blob/master/benchmark.py) script on a MacBook 2017 with a Redis running locally using defaults (except snapshotting that I had turned off).

Before performing any of the tests, the benchmark script begins by populating the database with 1000 keys and setting up the cache manager with a capacity for 100. It then runs several tests, which are timed as means for measuring the performance. Each test is repeated five times for both types of connections: regular and cached.

The results from the first test actually demonstrates one of caching's disadvantages: cache misses. In this test, *single_read*, we read every key from the entire database just once, so every access to the local cache results in a miss:

<div id="chart_1"></div>

Note that the averages are computed only for the last runs, so every first run in the series is considered a warmup. The averages above show that the missed cache reads add almost 13ms for every 1000 reads, or roughly an 18% increase of the latency.

However, repeating the test on a dataset that fits into the cache, that is only 100 keys, shows encouraging results. While the first cached run shows an increased in latency, subsequent ones reduce it by two orders of magnitude:

<div id="chart_2"></div>

The next test is named *eleven_reads* because it reads every key in the database once along with 10 other keys that are always the same ones. This highly synthetic use case provides an even more dramatic proof of the cache's benefit (despite that not being the purpose, per se).

<div id="chart_3"></div>

The last test extends *eleven_reads* by with an additional write request to one of the 10 constant keys, which triggers the invalidation of a part of the cache. We can see that latency of cached runs increase slightly, both because of the extra write command but also due to the need to refetch the contents of the cache:

<div id="chart_4"></div>

## Parting thoughts
This was a good way to spend some time caching. You may be already familiar with Redis' [keyspace notifications](https://redis.io/topics/notifications), which are events about the keyspace - such as modifications to keys - sent on PubSub channels. Keyspace notifications can, in fact, be used therefore much in the same manner as Redis Server-Assisted Client-Side Caching to achieve similar results.

Because PubSub is not a reliable means of transmitting messages, using either keyspace notifications or RESP2-based RSACSC, can result in lost invalidation notifications and stale content. With RESP3, however, RSACSC will be a superior mechanism for that even if only for the fact that notifications will be delivered as long as the connection is connected. A disconnect can, for example, then be dealt with by a local cache reset.

The move in RESP3 from PubSub broadcasting to connection-specific notifications also means that clients will get invalidation notifications only for slots that interest them. That means less resources spent on communication, and less is better.

Regardless of the RESP version used, from the point of view a client author, RSACSC can be used for caching much more than just the `GET`ting of entire strings. The mechanism is agnostic of the actual data structure used for storing the key's value, so all core Redis types and any custom ones declared by modules can be used with it.

Furthermore, instead of just caching keys-values, the client can be made to cache requests and their replies (while keeping track of the involved keys). Doing so will enable caching of substrings returned [`GETRANGE`](https://redis.io/commands/getrange), list elements obtained via [`LRANGE`](https://redis.io/commands/lrange)
or any other type query basically.

## One final note about Redis' CRC64 function
I wrote above that _"Python is robust enough to have anything I could possibly need."_ The one thing I didn't want to implement in this exercise was a CRC function, and I took it for granted that Python would have the right one for me.

To find which CRC Redis is using one could just look at its source code - the file [_src/crc64.c_](https://github.com/redis/antirez/blob/unstable/src/crc64.c) tells us right at the beginning that:

```c
/* Redis uses the CRC64 variant with "Jones" coefficients and init value of 0.
 *
 * Specification of this CRC64 variant follows:
 * Name: crc-64-jones
 * Width: 64 bites
 * Poly: 0xad93d23594c935a9
 * Reflected In: True
 * Xor_In: 0xffffffffffffffff
 * Reflected_Out: True
 * Xor_Out: 0x0
 * Check("123456789"): 0xe9c6d914c4b8d9ca
```

I did a quick search for _"Python CRC64 jones"_ and after skimming the [docs](http://crcmod.sourceforge.net/crcmod.predefined.html) I chose to `pip install crcmod` to use its predefined _crc-64-jones_ digest.

Some time later, and much more than I'd care to admit, I found the reason why my stuff wasn't working. A closer inspection of the docs revealed that crcmod uses a different (off-by-one but that's a different joke) polynomial. Here they are together, can you spot the difference?

```txt
Redis   0xad93d23594c935a9
crcmod 0x1AD93D23594C935A9
```

Whats more, crcmod had adamantly refused to use Redis' polynomial pettily claiming:
```txt
>>> crcmod.mkCrcFun(0xad93d23594c935a9)
Traceback (most recent call last):
 ...
ValueError: The degree of the polynomial must be 8, 16, 24, 32 or 64
```

I then, of course, just gave up and ported the Redis CRC64 implementation. Not exactly a hard task - one copy-paste, a few search-replace and one line of actual code to rewrite. If you're going to give RSACSC a go, make sure that the CRC64 implementation you're using checks out to _0xe9c6d914c4b8d9ca_.
