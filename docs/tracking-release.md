# Tracking SDC releases

This quick guide can be used to manually track SDC release upgrades (i.e. not master).

## Requirements 
- headnode Internet access
- imgapi zone Internet access

## Working with SDC release images

### List all available SDC images from Joyent's online repository

    updates-imgadm list > /var/tmp/sdc-images-all.txt

### Filter list to only contain SDC release images

    updates-imgadm list | grep release > /var/tmp/sdc-release-images.txt

Important: Don't forget to record the UUIDs for all images planned for the upgrade process. This will
help document deployed releases and if required, apply the same images across multiple
SDC environments (e.g. test or production)

### Update sdcadm to latest version

    sdcadm self-update

Check version with `sdcadm --version`

### Get the services update list

Get the list of local instances/services to be upgraded:

    sdcadm instances
    sdcadm services

The service names are required for updates, save the service names listed above to a text file for later reference.

### Extract the desired release images

Extract release-date from `/var/tmp/sdc-release-images.txt`
Example:

grep release-20150305 /var/tmp/sdc-release-images.txt | sort -u > /var/tmp/sdc-release-20150305-images.txt

### Translate friendly service names to image names

    cat /opt/smartdc/sdcadm/etc/defaults.json | json imgNameFromSvcName > /var/tmp/service-image-names.txt

### Download all release upgrade images for services 

Download each service image with sdcadm update <servicename>@<IMG_UUID> --just-images

#### First check service image name (cross reference it)
     Example:
   
    grep manatee /var/tmp/service-image-names.txt

    "manatee": "sdc-postgres"

In this example service manatee actual image name is sdc-postgres

#### Check available release image:

    grep sdc-postgres /var/tmp/sdc-release-20150305-images.txt

    0d05311e-c31d-11e4-8c8f-df1bc613f11a  sdc-postgres            release-20150305-20150305T094458Z-gad45608        I      smartos  2015-03-05T09:45:24Z

#### Grab the image UUID (first field) and download image with: `sdcadm update <servicename>@<IMG_UUID> --just-images`
     Example:

    sdcadm update manta@0d05311e-c31d-11e4-8c8f-df1bc613f11a --just-images

#### Repeat the download process for each individual service i.e. moray, cloudapi, binder, vmapi, sdc, papi etc.
     Don't forget to record each `<servicename>@<IMG_UUID>` - this will be needed later when the actual upgrade is executed.

#### As a last step download rabbitmq image

    sdcadm update rabbitmq@UUID --just-images --force-rabbitmq

#### Download latest gz-tools

    sdcadm experimental update-gz-tools --latest --just-download

#### Download release agents (called agentsshar)

    sdcadm experimental update-agents <IMG_UUID> --just-download

#### Download the platform release image (`grep platform /var/tmp/sdc-release-20150305-images.txt`)

    sdcadm platform install UUID


## Proceeding with the upgrade

### Verify the DC is healthy

In the future, you should only run `sdcadm check-health` in order to know if
all the services on a given SDC setup are healthy. Until that happens, it's
also recommended to run `sdc-healthcheck` to check if anything is out of
order.

The logical first step if something is not working properly would be to fix
that issue before proceeding with the upgrade, unless you know the upgrade
itself contains the fix for such problem.

### Put the DC in maintenance

    sdcadm experimental dc-maint --start

### Backup PostgreSQL

    MANATEE0_UUID=$(vmadm lookup -1 alias=~manatee)
    zfs snapshot zones/$MANATEE0_UUID/data/manatee@backup
    zfs send zones/$MANATEE0_UUID/data/manatee@backup > /var/tmp/manatee-backup.zfs
    zfs destroy zones/$MANATEE0_UUID/data/manatee@backup

### Upgrade Global Zone Tools

    sdcadm experimental update-gz-tools <IMG_UUID>

### Upgrade other SDC minor pieces, if required

    sdcadm experimental update-other

### Upgrade agents

    sdcadm experimental update-agents <IMG_UUID>

### Upgrade all the non-HA services
    
Proceed with all non-HA services one-by-one (except manatee,binder and rabbitmq).
Have the previously recorded `<service>@<IMG_UUID>` list available at hand.

    sdcadm update <service>@<IMG_UUID>

   
As last step update rabbitmq with the `--force-rabbitmq` flag

    sdcadm update rabbitmq@<IMG_UUID> --force-rabbitmq

### HA

At this point, you should be able to either update the HA pieces of SDC, or (in
case you haven't gone through HA setup yet) proceed with HA setup, taking
advantage of the DC maintenance period.

Of course, you can also complete the HA setup whenever you need to. Let's
assume that you already went through the process described to complete the
post-setup installation of SDC HA pieces, and we're going to just update an
existing HA setup. In such case, you just need to run:

    sdcadm update binder

Then, run `sdc-healthcheck` to make sure everything is properly reconnected
to moray. Once binder VMs have been updated, the next step is to update
manatee by running:

    sdcadm update manatee

Again, some `sdcadm check-health`/`sdc-healthcheck` is highly recommended.

### Assign platform and reboot accordingly

Note that you only need to go through this step if you plan to upgrade the OS
platform during the overall upgrade.

You can assign the downloaded platform image to one or more servers using:

      sdcadm platform assign PLATFORM SERVER_UUID
      sdcadm platform assign PLATFORM --all

where `PLATFORM` is the platform version. If you need to update more than one
server, but don't want to update all of them, you'll need to run

      sdcadm platform assign PLATFORM SERVER_UUID

as many times as the servers you need to update.

Once you're done with this procedure, reboot the servers so they're running with
the updated platform assignment.

In case you need to reboot the HeadNode:

      init 6

And, in order to reboot other CNs:

      sdc-cnapi /servers/$CN_UUID/reboot -X POST

### Take the DC out of maintenance

    sdcadm experimental dc-maint --stop

And that's it. With this final step, the DC should be full operational again.
It's a good idea to run the health check commands before stopping the
maintenance window, just in case.

Finally, if you have some Amon alarms raised during the upgrade period, this is
a good moment to clear them all.

