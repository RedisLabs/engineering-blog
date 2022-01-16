
```java
package redis.embedded;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import redis.clients.jedis.HostAndPort;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisCluster;

import static org.junit.Assert.assertEquals;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

public class RedisServerShardedClusterTest {

    private RedisServer redisServer1;
    private RedisServer redisServer2;

    @Before
    public void setUp() throws Exception {
        redisServer1 = RedisServer.builder()
                .port(7379)
                .setting("cluster-node-timeout 50")
                .setting("cluster-enabled yes")
                .setting("cluster-config-file /tmp/redis_cluster_node_" + UUID.randomUUID().toString() + ".conf")
                .build();

        redisServer2 = RedisServer.builder()
                .port(7380)
                .setting("cluster-node-timeout 50")
                .setting("cluster-enabled yes")
                .setting("cluster-config-file /tmp/redis_cluster_node_" + UUID.randomUUID().toString() + ".conf")
                .build();

        redisServer1.start();
        redisServer2.start();
        
        Jedis node1 = new Jedis("localhost", 7379);
        Jedis node2 = new Jedis("localhost", 7380);
        node1.clusterMeet("127.0.0.1", 7380);
        
        // split available slots across the three nodes
        int slotsPerNode = JedisCluster.HASHSLOTS / 2;
        int[] node1Slots = new int[slotsPerNode];
        int[] node2Slots = new int[slotsPerNode];    
        for (int i = 0, slot1 = 0, slot2 = 0; i < JedisCluster.HASHSLOTS; i++) {
          if (i < slotsPerNode) {
            node1Slots[slot1++] = i;
          } else {
            node2Slots[slot2++] = i;
          }
        }

        node1.clusterAddSlots(node1Slots);
        node2.clusterAddSlots(node2Slots);

        // Wait for cluster ready
        Thread.sleep(2000);
    }

    @Test
    public void testSimpleOperationsAfterRun() throws Exception {
    	
    	Set<HostAndPort> jedisClusterNode = new HashSet<>();
        jedisClusterNode.add(new HostAndPort("127.0.0.1", 7379));
        jedisClusterNode.add(new HostAndPort("127.0.0.1", 7380));
        
        JedisCluster cluster = new JedisCluster(jedisClusterNode);            
        cluster.set("abc", "1");
        assertEquals("1", cluster.get("abc"));
    }


    @After
    public void tearDown() throws Exception {
        redisServer1.stop();
        redisServer2.stop();
    }
}
```java
