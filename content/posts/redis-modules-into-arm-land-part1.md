---
title: "Getting Redis Modules into ARM land - Part 1"
date: 2019-11-13
authors:
  - Rafi Einstein
tags: ["redisedge", "arm"]
---

Our motivation at Redis Labs of getting into ARM land and dragging Redis Modules along was RedisEdge.
Redis, of course, has long been native in this land, in both glibc and alpine/musl variants.
Redis Modules, although already on the multi-platform scene (running on various Linux distributions and supporting macOS, mainly for the sake of development experience), have been more of an enterprise/data-center thing, all until RedisEdge came along, targeting IoT devices.
In this series of posts, I'll describe our vision of ARM platform support and the developer user experience, as well as the steps we took along the path, as the way was as valuable as the outcome.

If you'll follow through, you'll end up with a fully functional ARM build laboratory.

## Inside RedisEdge

![redisedge1](/redis-modules-arm-1.png)

But first, let's take a look at RedisEdge.
RedisEdge is not a Redis module, but an aggregate of three Redis modules: RedisGears, RedisAI, and RedisTimeSeries.
It is distributed as a Docker image, which is based on Redis Server 5.0. Thus, one can simply pull the image, run it, and start issuing Redis commands, load models into RedisAI, and execute Python gears scripts on RedisGears.
Although one can easily get Docker out of the equation (by installing a Redis server and copying Redis Modules files), we'll see that Docker does actually provide significant added value, and it is worthwhile keeping it around.

![redis-edge-1](/redis-modules-arm-2.png)

*Inside RedisEdge: modules structure*

Let's now take a look at each of the components of RedisEdge, to try to figure out what would it take to have them ported to ARM.
First, **RedisTimeSeries**. 
It's a simple C library, built with make. Not even a configure script. No problems there.
Next is **RedisGears**. It's too a C library built with plain make, but it does use an embedded Python 3.7 interpreter, which is built from source. This requires running automake to generate a platform-specific makefile.
Finally, **RedisAI**. It's a C library built with CMake, and it includes modular "engines" that allow abstraction and encapsulation of AI libraries like TensorFlow, PyTorch, and ONNXRuntime, in their C library form (most users typically use them in Python), with PyTorch and ONNXRuntime not officially supporting ARM.
So the build requirements, as it seems, have deteriorated quickly. It went from building an innocent C library to compiling massive source bases with convoluted build systems.

In the next sections, we will fit each components with its proper build method.

## Building for ARM

At this point, we'll pause and take stock of what is required to build software for ARM.
The obvious way is to use an ARM-based device, like Raspberry Pi. Once set up, you'll be able to build and test in the most natural manner. 

The testing medium is important: even though you can build almost every ARM software without a physical ARM device, there is no reliable way of testing the outcome in a reliable way without such a device, especially with non-standard devices. Therefore, as much as virtualized/emulated/containerized test may be useful, you should always test your software on its designated target device.

A Raspberry Pi 4 with 4GB RAM (and not less importantly, a 1Gbps NIC) and a fast microSD card looks indeed very promising.

Now, regarding the OS selection on ARM: the offerings are limited, and the rule of thumb is going for the latest release of either Raspbian (which is customized Debian distribution for RPi) or either Ubuntu or Fedora, both offering easy-to-install ARM systems. Do not worry about immaturity: it was proven time
and again that newer systems work better and old ones can't keep up.

Installing an OS brings us to the first dilemma: 
If we install Raspbian, we get a 32-bit OS (i.e., arm32v7 platform).
If we choose 64-bit Ubuntu, we get an arm64v8 platform (we discuss ARM platforms in detail later). 
If we intend (as we do with RedisEdge) to support both platforms, we can either get two SD cards, and install each OS on its own card, taking turns on the device, or get two RPi devices (which is not terribly expensive). I recommend the latter.

And now, for the principal principle of OS selection: our goal is to have a stable system with the newest Docker version. Any OS that will satisfy these requirements will do.
That's right: we're going to use Docker to fetch the OS we really with to build for, using the underlying OS as infrastructure. This will also help keep our build experiments properly isolated.

If you have a RPi device at your disposal, you can now proceed to making it functional. Otherwise, you can skip this section, as we will present build methods that do not require a physical ARM machine.

#### Installing Ubuntu 19.04 on RPi 3 & 4

Very good and detailed instructions of how to download and install the latest Ubuntu Server for ARM on RPi can be found [here](https://ubuntu.com/download/iot/raspberry-pi), for Linux, Windows, and macOS. However, you should follow the following instructions to install Ubuntu 19.04 rather than the latest released version:

- Get a microSD Card: 64GB, Class 10, anything comparable (that is, at the same price level) to Samsung EVO or SanDisk Ultra will do.
- Download the OS [image](http://cdimage.ubuntu.com/releases/19.04/release/ubuntu-19.04-preinstalled-server-arm64+raspi3.img.xz) (typically .img or .raw format, archived) and extract it. While it is possible to install from an .iso file, using .img images is much more straightforward and therefore recommended.
- Write it to a microSD card with a tool like [Balena Etcher](https://www.balena.io/etcher/) (it's available for all platforms, I personally use [Win32 Disk Imager](https://sourceforge.net/projects/win32diskimager/)). In order to write, you should use the build-in microSD reader in your laptop or get an external one with a USB interface.
- Insert the microSD into the RPi and power the device on.
- Username/password: ubuntu/ubuntu

#### Installing Raspbian Buster on RPi 3 & 4

* Repeat the above steps, with Raspbian Lite [image](https://downloads.raspberrypi.org/raspbian_lite_latest).
* Username/password: pi/raspberry

#### Connecting to Workstation

By "workstation" I refer to a Linux or macOS host, that holds one's development environment and git repositories. As a side note,  I warmly recommend using a desktop PC (that's another blog post), though most people use laptops. In either case, I also recommend having some virtualization infrastructure on your workstation, VMware Workstation/Fusion or VirtualBox being good solutions.

So, we need to establish a network connection between the RPi and the workstation. As mentioned before, RPi 4 has a 1Gbps NIC, which is a great improvement over the RPi 3 with its 100Mbps NIC. Connecting the RPi to a network is simple: get any gigabit Ethernet unmanaged switch and two Ethernet cables, then hook the RPi to the switch and connect the switch to your gateway Ethernet port. You can hook your workstation to the switch as well.

At this stage, we need to gather some information from the workstation. 

First, we need to determine UID & GID of the workstation user that owns the views:

```
id
```

We'll call them MY-UID & MY-GID.

Next, we need to find out what's our time zone

```
timedatectl
```

We'll call it MY-TIMEZONE.

Finally, we'll need your workstation's IP:

```
ip a
```

We'll call if MY-WORKSTATION-IP.

#### RPi Configuration

During the initial setup, you'll need to have the RPi connected to a monitor and a keyboard. Once setup is done, it can be controlled from your workstation via SSH.

Another good practice is to avoid cloning source code into the RPi, but rather share it between your workstation and RPi via NFS.

For convenience, I assume we operate as root (via ```sudo bash```, for instance).

So let's get on with the configuration:

##### Hostname

```
hostnamectl set-hostname MY-HOSTNAME
```

##### Time zone and NTP

```
# recall MY-TIMEZONE from previous section
timedatectl set-timezone MY-TIMEZONE
# confirm settings
timedatectl
```

##### SSH server

```
apt-get -qq update
apt install -qy openssh-server
systemctl start openssh-server
systemctl enable openssh-server
```

##### IP

```
ip a
# record ip address, connect via ssh from workstation
```

##### NFS client

```
apt install -qy nfs-common
mkdir -p /mnt/views
ln -s /mnt/views /v
```

Add the following to ```/etc/hosts```:

```
workstation MY-WORKSTATION-IP 
```

Also, add the following line to ```/etc/fstab```:

```
workstation:/views /mnt/views nfs defaults 0 0
```

##### Utilities

```
apt install -qy tmux ca-certificates curl wget htop mc tmux
```

#### On the workstation side

Regarding git repositories, I'll use the following terminology and structure throughout the discussion. This is not essential and one may organize matters differently. The term "view" refers to a set of git repository clones, that one uses in a certain context. For instance, if we work on RedisEdge modules in the context of ARM compilation, we'll end up with the following directory structure:

```
/views/arm1/
	RedisEdge
	RedisTimeSeries
	RedisGears
	RedisAI
```

Here 'arm1' is the view name, and the directories it contains are the result of the corresponding ```git clone``` commands. There may be other views, serving other contexts. The idea is to share this structure among all hosts and containers to avoid the hassle of moving code around and git key management.

For even more convenience, I add the following link:

```
mkdir /views
ln -s /views /v
```

So, finally, we get to set up NFS:

Now proceed as root:

##### Ununtu/Debian:

Note the MY-UID and MY-GID values.

```
apt-get -qq update
apt-get install -qy nfs-kernel-server nfs-common
echo "/views *(rw,all_squash,anonuid=MY-UID,anongid=MY-GID)" >> /etc/exports
systemctl start nfs-kernel-server
systemctl enable nfs-kernel-server
```

##### Fedora/CentOS:

Note the MY-UID and MY-GID values.

```
yum install nfs-utils
echo "/views *(rw,all_squash,anonuid=MY-UID,anongid=MY-GID)" >> /etc/exports
systemctl start rpcbind nfs-server
systemctl enable rpcbind nfs-server
```

Note that if you've got your workstation firewall enabled, it might interfere with NFS. Consider turning it off for wired connections.

#### Back to the RPi

Now that we have NFS set up on the workstation, we can mount the views directory into the RPi:

```
mount -a
ls /v
```

Finally, we can install Docker and Docker Compose.

##### Installing Docker on Ubuntu 19.04:

```
# install Docker
curl -fsSL https://get.docker.com | sh

# install Docker Compose
curl -L "https://github.com/docker/compose/releases/download/1.24.1/docker- compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
```

##### Installing Docker on Raspbian Buster:

```
# install Docker
apt-get install \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg2 \
    software-properties-common
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo apt-key add -
add-apt-repository \
    "deb [arch=armhf] https://download.docker.com/linux/raspbian buster stable"
apt-get -qq update
apt-get install docker-ce docker-ce-cli containerd.io
# this will prevent "docker login" failure
rm -f /usr/bin/docker-credential-secretservice

# install Docker Compose
apt-get install -y pass gnupg2
apt-get install -y python libffi-dev python-openssl python-dev
curl -sSL https://bootstrap.pypa.io/get-pip.py | python
pip2 install docker-compose==1.24.1
```

## On the next chapters

In the next post, I'll present the developer experience we're aiming for, discuss ARM platforms in detail, present methods for building for ARM without using ARM hardware, and start putting theory into practice with RedisEdge modules.

Stay tuned!