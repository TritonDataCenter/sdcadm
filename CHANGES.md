# sdcadm Changelog

# 1.2.4

- Add 'sdcadm check-config'.

- Add 'sdcadm experimental ...'  where experimental commands will hang
  until fully integrated into the planned upgrade process.

# 1.2.3

- Save old user-script to 'sdcadm update' work dir for possible rollback.


# 1.2.2

- `config.vmMinPlatform` guard for minimum platform supported for core
  VM updates.
- `sdcadm svcs` lists one service per row, JSON is mostly from SAPI's
  ListServices.
- `sdcadm insts -I` to group by (service, image) unique pairs


# 1.2.1

- 'sdcadm update' will correctly do nothing (saying "Up-to-date") if the given
  services are already at the latest candidate image. It also now properly
  excludes images published earlier than the currently used image as update
  candidates.
- 'sdcadm update <svc>@<version>' and other calling forms

# 1.2.0

- Change shar self-installer input envvar from SDCADM_LOGDIR to SDCADM_WRKDIR.
- 'sdcadm update -I ...'

# 1.1.0

- First stab at `sdcadm update SERVICE`. Currently limited to most of the stateless
  services (e.g. vmapi, cnapi) with just a single instance, and only on the headnode.

# 1.0.4

- TOOLS-437: `sdcadm instances`, `sdcadm services`.

# 1.0.3

- TOOLS-436: `sdcadm self-update`

# 1.0.0

First version.
