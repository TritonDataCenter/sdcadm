---
title: sdc configuration variables
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns, footnotes
markdown2linkpatternsfile: link-patterns.txt
apisections: SDC Config
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# SDC Config

There are many places where SDC configuration variables are defined due to
different reasons, including backwards compatibility, SDC setup process
requirements, ...

This document is just an attempt to begin documenting each one of these
variables, in which places it's defined, and which ones could be the possible
sources of conflict between these different places where the same variable
could take different values.

The `sdcadm check-config` command aims to help reviewing SDC configuration,
taking as *"desired configuration"* the `metadata` values given to the `sdc`
application in `SAPI`, and comparing them with the *"real"* values in the
system.

## Packages

Variables with name from `pkg_1` to `pkg_$n` where `$n=11` right now ([^1]). These are
just the SDC Packages used to create the different core zones. The packages
are added to PAPI during the first `papi` VM setup process.

Additionally, the values matching the pattern `${SERVICE_NAME}_pkg` are used
as packages for the creation of the VMs associated with such services;
(see `usb-headnode.git:/scripts/build-payload.js`).


## Headnode general config and setup

There are some variables used either during headnode setup process or to
configure Headnode global zone:

- `install_agents` [^1]: Should or not install agents during HN setup?
- `initial_script` [^1]: Relative path, within USB key directory, to the headnode
  setup script
- `utc_offset` [^1]: String containing the numeric value for the headnode UTC
  offset, (default `"0"`).
- `agents_root` [^1]: Absolute path to agents directory.
- `zonetracker_database_path` [^1]: Absolute path to zonetracker SQLite DB file.
- `root_authorized_keys_file`[^1]: The name of the file to be used as SSH
  authorized keys source for `root` account.
- `coal`: Is the current setup a COAL setup?
- `swap`: SWAP of the Headnode, expressed as percentage of available disk
  space.
- `compute_node_swap`: SWAP of the Compute Nodes, expressed as percentage of
  available disk space.
- `default_rack_name`: Name of the default rack.
- `default_rack_size`: Default size for racks
- `default_server_role`: Default role for CNs
- `default_package_sizes`: Comma separated list of default RAM size for packages.

## Email notification settings

These settings are used by all services in your cloud for email messages

- `mail_to`
- `mail_from`

## Service Bundles API

The URL to upload service bundles, with the required user name and password.
Usually, these variables shouldn't be modified at all: `sbapi_url`,
`sbapi_http_user`, `sbapi_http_pass`.


## Datasets API

The URL to retrieve public Images, including the required user and password.
In general, it shouldn't be modified: `dsapi_url`, `dsapi_http_user`,
`dsapi_http_pass`.

## Datacenter details

- `datacenter_name`: The name for the current data center. It's assigned to the
GZ global variable `$DC_NAME`, and it's used for SDC services naming as:
`service_name.datacenter_name.dns_domain`.
- `region_name`: A set of data centers that are interconnected by low-latency,
high-bandwith links are said to be in the same `region`. Unlike `SDC` services,
which are scoped to a single DC, a `manta` exists on a given `region`. This
region is used for manta services naming: `service_name.region.dns_domain`
instead of `service_name.datacenter_name.dns_domain`.
- `datacenter_company_name`: The name of the company who owns the SDC setup.
- `datacenter_location`: The physical location of the DC.

These values are also set into `UFDS`, and can be retrieved using:

        sdc-ldap search "(&(objectclass=datacenter)(datacenter=$DC_NAME))"

The variable names are sigly different for the UFDS entries:

- `datacenter`: Equivalent to `datacenter_name`.
- `region`: Equivalent to `region_name`.
- `company`: Equivalent to `datacenter_company_name`.
- `address`: Equivalent to `datacenter_location`.

Both, `datacenter` and `region` values must be properly set for the correct
operation of the binder service, for both, `manta` and `SDC`.


## UFDS details

Additionally to the aforementioned information about the DC, there are some
configuration values required for the correct operation of the UFDS service:

- `ufds_is_master`: Is the current DC the ufds master?. When that's not the
  case, `ufds_remote_ip` containing information about the ufds master location
  is also required for the ufds-replicator service.
- `ufds_ldap_root_dn` and `ufds_ldap_root_pw` are required to connect to the
  ufds service. Of course, both are used during ufds VM setup.
- `ufds_admin_login`: login name for the main ufds user. Usually, `admin`.
- `ufds_admin_pw`: Password for the aforementioned user.
- `ufds_admin_email`: Email for the main user.
- `ufds_admin_uuid`: UUID for the admin user. Note this value will be used as
  owner of all the VMs created for the core SDC services.
- `capi_client_url`: HTTP proxy to UFDS, required by smartlogin v1 service.
- `ufds_admin_key_fingerprint` and `ufds_admin_key_openssh` are also stored for
  the admin user and, among others, are used by the `sdc-healthcheck` utility
  to check what's the status for CloudAPI.


## Smart Login

- `capi_client_url`: URL of the CAPI service required by Smart Login

## Network configuration

`admin_nic` is the nic `admin_ip` will be connected to for headnode zones:

- `admin_nic`
- `admin_ip`
- `admin_netmask`
- `admin_network`

`external_nic` is the nic `external_ip` will be connected to for headnode zones:

- `external_nic`
- `external_ip`
- `external_gateway`
- `external_netmask`
- `external_network`
- `external_provisionable_start`: The IPv4 address of the first provisionable
  IP on the external network
- `external_provisionable_end`: The IPv4 address of the last provisionable
  IP on the external network
- `headnode_default_gateway`

- `binder_resolver_ips`: comma separated list of reserved IPs for binder instances
- `dns_resolvers`: comma separated list of DNS resolvers
- `dns_domain`: Domain to be used to create instance hostnames

## DHCP settings for compute nodes on the admin network

- `dhcp_range_start`
- `dhcp_range_end`
- `dhcp_lease_time`

## /etc/shadow config

- `root_shadow`: entry from /etc/shadow for root 
- `admin_shadow`: entry from /etc/shadow for the admin user

## NTP settings
- `ntp_hosts`: Comma separated list of NTP hosts for the Headnode
- `compute_node_ntp_hosts`: Comma separated list of NTP hosts for the Compute
  nodes.

## Service VMs details

For every VM used to run one or more of the `SDC` services, we have a set of
common variables sharing a common naming pattern:

- `${SERVICE_NAME}_root_pw` 
- `${SERVICE_NAME}_admin_ips`
- `${SERVICE_NAME}_domain`

Usually, the value for all the `${SERVICE_NAME}_root_pw` is the same, and the
value for the `${SERVICE_NAME}_domain` matches the pattern
`service_name.datacenter_name.dns_domain` and could be easily figured out from
these values.

The most important variable here is `${SERVICE_NAME}_admin_ips`, which can be
set to one or more IPv4 addresses. In the past, each time a new instance was
created, a new IP value was added to these variables but nowadays, these are
nevermore added and this value remains set to the original value it was
initially set when created the DC, which may or not match with the first VM
running the service (usually with alias `${SERVICE_NAME}0`).

Additionally, there's also an entry with name `${UPPERCASE_SERVICE_NAME}_SERVICE`
for most of the services, with similar contents to `${SERVICE_NAME}_domain`.

Finally, `cnapi`, `fwapi` and `napi` also set the variable
`${SERVICE_NAME}_client_url` pointing to the URL of their respective HTTP servers.


## Other settings:

- `adminui_help_url`: AdminUI documentation
- `dhcpd_dhcp_server`
- `dbconn_retry_after`
- `dbconn_num_attempts`
- `napi_mac_prefix`
- `phonehome_automatic`
- `show_setup_timers`
- `config_inc_dir` [^1]: Full path to config directory. (Usually `/usbkey/config.inc`).
- `ZK_SERVERS` [^1]: Zookeeper servers
- `manatee_shard` [^1]: Which manatee shard should use (`sdc`).
- `sapi-url` [^1]: URL to SAPI
- `assets-ip` [^1]: Admin IP of the assets VM
- `SDC_PRIVATE_KEY` [^1]: Private SSH key for the SDC setup
- `SDC_PUBLIC_KEY` [^1]: Public SSH key for the SDC setup
- `SDC_KEY_ID` [^1]: Fingerprint of the SSH key for the SDC setup

## TODO (Review Required)

- Shouldn't we choose between `${SERVICE_NAME}_domain` and
  `${UPPERCASE_SERVICE_NAME}_SERVICE`?.
- Why cloudapi's `cloudapi_domain` is missing?
- Why `assets_pkg` and `sapi_pkg` are then only remaining `*_pkg` variables?
- Are the following variables still in use?: `install_agents`, `initial_script`,
  `utc_offset`, `agents_root`,`zonetracker_database_path`.
- Why is `adminui_workers` a top level metadata value (SDC) instead of being
  just an `adminui` service value?.
- Is any of the `${SERVICE_NAME}_client_url` other than `capi_client_url` used
  anywhere?.

[^1]: Variables not included into `/mnt/usbkey/config` file.
