/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * A library with data and tools for managing headnodes.
 */

var assert = require('assert-plus');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');

var Procedure = require('./procedures/procedure').Procedure;


var format = util.format;


/*
 * Minimum versions of core components required to support multiple headnodes.
 *

Min versions required on a CN:

- gz-tools: To convert a CN to an HN, the CN must have: gz-tools update (for HEAD-2343)
    18/Jan/17 3:40 PM
    release-20170119
  XXX how do we know which gz-tools is installed?

- platform: Need update to fs-joyent for first boot of CN to becoming an HN.
    XXX only in rfd67 branch of smartos-live now

Min versions requires on all nodes:

- dhcpd (aka binder): To support a headnode other than with the hostname
  "headnode", all dhcpd instances must have NET-371 to get an hn-netfile
  that works for those headnodes.
    18/May/2017
    release-20170525
  Technically this is only required if setup for fabrics, but then is the
  good time to check... else a operator could setup fabrics later and get
  screwed.

 */




/*
 * A `Procedure` for setting up one or more servers to be headnodes.
 */

function ProcHeadnodeSetup(args) {
    assert.object(args, 'args');
    assert.arrayOfObject(args.servers, 'args.servers');
    args.servers.forEach(function (s) {
        assert.ok(!s.headnode,
            format('server %s is not already a headnode', s.hostname));
    });

    this.servers = args.servers;
}
util.inherits(ProcHeadnodeSetup, Procedure);

ProcHeadnodeSetup.prototype.summarize = function summarize() {
    var parts = [];
    this.servers.forEach(function (s) {
        parts.push(format('Setup server %s (%s) as a secondary headnode.',
            s.uuid, s.hostname));
    });
    parts.push('warning: Headnode setup involves two reboots of the server.');

    // XXX warn that this'll replace the USB key content on the server?

    // XXX specific warnings about manatee *sync* and *primary*
    //p('- CN %s hosts a manatee (Triton core postgres) instance. The');
    //p('  reboots can result in short manatee availability blips as');
    //p('  XXX');

    return parts.join('\n');
};

/*
 * Process:
 * - first run we'd have to create /usbkey/extra/headnode-prepare/...
 *      TODO: ticket to have headnode.sh do this
 *      TODO: ticket to have various update steps update /usbkey/extra/... as
 *          appropriate
 *      It feels messy to need this coordination (updating /usbkey/extra/...).
 *      It would be nice if the APIs automatically held this data and
 *      setup/update on CNs could pull from them.
 * - call CNAPI headnode-setup job
 * - ... XXX START HERE
 *
 *
 *
 *  - Setup the USB key:
 *      - Q: Do we clean out *other* unrelated files on the USB key? If so,
 *        we warn about doing so. Perhaps try not to warn if it just looks like
 *        older triton USB key bits on there.
 *      - /mnt/usbkey/config
 *      - TODO: work through with a *minimal* set on the USB key to see what
 *        is needed
 *              /mnt/usbkey/
 *                  .joyliveusb
 *                  boot/
 *                  config
 *                  config.inc/
 *                  firmware/ ?
 *                  license
 *                  os/
 *                  scripts/     # 'sdcadm ... update-gz-tools' updates these in /usbkey/scripts/...
 *                      ... only a subset needed, likely
 *                  tools.tar.gz    # TODO: need up to date version
 *                  cn_tools.tar.gz ?  # up-to-date version at /usbkey/extra/joysetup/cn_tools.tar.gz
 *                  install-sdcadm.tar.gz   # TODO: save latest copy of this for headnode-prepare
 *
    - task: create /mnt/usbkey/boot/networking.json for fabrics, if setup for that
      (get this config from the dhcpd zone)
    - task: setup.json file "node_type"
        Write this to not bother if there isn't a node_type in setup.json
        already, to support a future ticket dropping it.
    - task: drop /opt/smartdc/config/node.config
    - reboot
    - wait for the double reboot: setup=true and headnode=true in CNAPI?
 */
ProcHeadnodeSetup.prototype.execute = function execute(args, cb) {
    assert.object(args, 'args');
    assert.object(args.sdcadm, 'args.sdcadm');
    assert.object(args.log, 'args.log');
    assert.func(args.progress, 'args.progress');
    assert.func(cb, 'cb');

    var context = {};
    var sdcadm = args.sdcadm;
    var log = args.log;
    var p = args.progress;

    /*
     * XXX START HERE
     *
     * - put needed bits in /usbkey/extra/headnode-prepare for assets serving
     *   including headnode-prepare/headnode-prepare.sh
     *          headnode-prepare/
     *              headnode-prepare.sh
     *              usbkey/
     *                  ...
     *              config-$serverUuid   ???
     * - run headnode-prepare.sh via Ur (a la joysetup for server-setup job)
     *      XXX should this be a 'headnode-setup' job in CNAPI? Yes, probably.
     */
    vasync.pipeline({arg: context, funcs: [

    ]}, cb);
};


// ---- exports

module.exports = {
    ProcHeadnodeSetup: ProcHeadnodeSetup
};
