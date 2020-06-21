---
title: "Updating AWS autoscaling groups with Terraform and preserving desired capacity"
date: 2020-06-21
authors:
  - author:
      name: "Ariel Peltz"
      link: "https://github.com/arielpeltz"
tags: ["aws", "terraform", "autoscaling", "desired_capacity"]
---

## Introduction
Terraform is probably the best tool for deploying infrastructure, so it is an obvious choice
to deploy an autoscaling group into AWS.  The project we are working on requires us to
deploy a service on instances in AWS.  The service is stateless and has simple configuration that is
easy to configure using [cloud-init](https://cloudinit.readthedocs.io/en/latest/index.html).

Our goal is to configure everything with Terraform. Every time we need to make
a configuration change, we update the Terraform configuration and apply again.
We want to have clean instances when we make any configuration change and not update in place.

> Throughout the examples we omit the creation of some configuration elements for brevity.
> Others are injected as variables and are also not shown here.

## Initial Configuration
First create the launch template:
```terraform
# Query for the latest Ubuntu 18.04 AMI in the region
data "aws_ami" "ubuntu" {
  most_recent = true

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-bionic-18.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  owners = ["099720109477"] # Canonical
}

resource "aws_launch_template" "mysvc" {
  name                                 = "mysvc"
  ebs_optimized                        = true
  image_id                             = data.aws_ami.ubuntu.id
  instance_initiated_shutdown_behavior = "terminate"
  instance_type                        = "c5.large"
  key_name                             = var.key_name
  network_interfaces {
    associate_public_ip_address = true
    subnet_id                   = var.subnet_id
    security_groups             = var.security_groups
    delete_on_termination       = true
  }
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name          = "mysvc"
    }
  }
  user_data = base64encode(templatefile("${path.module}/user_data.yaml", {
    web_password    = var.web_password,
    ssl_private_key = tls_private_key.mysvc.private_key_pem,
    ssl_certificate = tls_self_signed_cert.mysvc.cert_pem
  }))

  # we don't want to create a new template just because there is a newer AMI
  lifecycle {
    ignore_changes = [
      image_id,
    ]
  }
}

```
The launch template defines the critical elements of the instance and also loads
the configuration of the service from the user data file.  The user data file is a template
that evaluates to a valid cloud-init configuration file.

Now let's create the autoscaling group
```terraform
resource "aws_autoscaling_group" "mysvc" {
  name                      = "mysvc-${aws_launch_template.mysvc.latest_version}"
  health_check_type         = "ELB"
  health_check_grace_period = 120
  termination_policies      = ["OldestInstance"]
  launch_template {
    id      = aws_launch_template.mysvc.id
    version = aws_launch_template.mysvc.latest_version
  }
  min_size = 1
  max_size = 10

  lifecycle {
    create_before_destroy = true
  }
  target_group_arns = [aws_lb_target_group.svc.arn]
}
```
There are a few things to note here:

1. We name the autoscaling group with the latest version of the launch template.  This is to make sure that when the launch template is updated we are creating a new autoscaling group.
1. When creating a new autoscaling group we want to first create the new one and then destroy the previous one, so we use the life-cycle directive `create_before_destroy = true`. As our service is behind an ELB this will ensure no down time during the configuration change.

This is great and does exactly what we need.  **Or does it?** 

What happens when we have scaled out the group to have more instances and we change the configuration?
With the current configuration we will replace the running group of, 5 instances, for example, with a group of only 1 instance.
We want to be able to create a new group with 5 instances.

## Better Configuration
In order to keep the current value of desired capacity we need to somehow get it first.

Let's get the current launch template, if it exists:
```terraform
data "aws_launch_template" "current" {
  filter {
    name   = "launch-template-name"
    values = ["mysvc"]
  }
}
```

Now let's see if we have autoscaling groups that use this launch template`s latest version:
```terraform
data "aws_autoscaling_groups" "current" {
  filter {
    name   = "key"
    values = ["mysvc-template-version"]
  }
  filter {
    name   = "value"
    values = ["${coalesce(data.aws_launch_template.current.latest_version, 0)}"]
  }
}
```
> we are using tags that you have not seen being added to the autoscaling group yet.
> See below for the changes in the autoscaling group resource.

The idea here is that either `data.aws_launch_template.current.latest_version` has a
value or it is `null`.  If there is a value, we expect to have a list of at most size one.
If it is null then we are looking for a non-existent autoscaling group and get a list
of size zero.

Now we can get the info on the current autoscaling group:
```tf
data "aws_autoscaling_group" "current" {
  count = length(data.aws_autoscaling_groups.current.names)
  name  = data.aws_autoscaling_groups.current.names[count.index]
}
```
Using `count` essentially creates either one or zero resources, per the size of
`data.aws_autoscaling_groups.current.names`.

Now we can update the autoscaling group resource:
```terraform
resource "aws_autoscaling_group" "mysvc" {
  name                      = "mysvc-${aws_launch_template.mysvc.latest_version}"
  health_check_type         = "ELB"
  health_check_grace_period = 120
  termination_policies      = ["OldestInstance"]
  launch_template {
    id      = aws_launch_template.mysvc.id
    version = aws_launch_template.mysvc.latest_version
  }
  min_size = 1
  max_size = 10

  desired_capacity = length(data.aws_autoscaling_groups.current.names) > 0 ? data.aws_autoscaling_group.current[0].desired_capacity : var.default_desired_capacity

  tag {
    key                 = "mysvc-template-version"
    value               = aws_launch_template.mysvc.latest_version
    propagate_at_launch = false
  }

  lifecycle {
    create_before_destroy = true
  }
  target_group_arns = [aws_lb_target_group.svc.arn]
}
```
Here we define the desired capacity by checking if we can find any current autoscaling groups.  If we can, then we use the first (and only)
autoscaling group value of desired capacity.  If however we cannot find any current groups then we use the default value.
We also remember to add the tag we need to query for the autoscaling group.

## Conclusion
Terraform is pretty cool and can be used to do many things.  Some require a little more jumping through hoops
but it is worth it to have everything in a single tool.
