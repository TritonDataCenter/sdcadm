---
title: sdc configuration variables
markdown2extras: wiki-tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections:
---

# SDC Config

There are many places where SDC configuration variables are defined, due to
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

## Packages:

Variables with name from `pkg_1` to `pkg_$n` where `$n=11` right now. These are
just the SDC Packages used to create the different core zones. The packages
are added to PAPI during the first `papi` VM setup process.

Additionally, the values matching the pattern `${SERVICE_NAME}_pkg` are used
as packages for the creation of the VMs associated with such services;
(see `usb-headnode.git:/scripts/build-payload.js`).


## Datacenter details

- `datacenter_name`: The name for the current DataCenter. It's assigned to the
GZ global variable `$DC_NAME`, and it's used for SDC services naming as:
`service_name.datacenter_name.dns_domain`.
- `region_name`: A set of datacenters that are interconnected by low-latency,
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
