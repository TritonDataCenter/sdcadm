/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * 'sdcadm post-setup ...' CLI commands.
 */

var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var util = require('util');




// --- PostSetup CLI class

function PostSetupCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm post-setup',
        desc: 'Common post-setup procedures.\n' +
            '\n' +
            'The default setup of a Triton Data Center headnode is somewhat\n' +
            'minimal. "Everything up to adminui." Practical usage of\n' +
            'SDC -- whether for production, development or testing --\n' +
            'involves a number of common post-setup steps. This command\n' +
            'attempts to capture many of those for convenience and\n' +
            'consistency.\n',
        helpOpts: {
            minHelpCol: 26
        },
        helpSubcmds: [
            'help',
            { group: 'General Setup', unmatched: true },
            { group: 'Development/Testing-only Setup' },
            'dev-headnode-prov',
            'dev-sample-data'
        ]
    });
}
util.inherits(PostSetupCLI, Cmdln);

PostSetupCLI.prototype.init = function init(_opts, _args, _cb) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress; // Deprecated. Use `ui`.
    this.ui = this.top.ui;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


PostSetupCLI.prototype.do_cloudapi = require('./cloudapi').do_cloudapi;
PostSetupCLI.prototype.do_common_external_nics =
    require('./common-external-nics').do_common_external_nics;
PostSetupCLI.prototype.do_underlay_nics =
    require('./underlay-nics').do_underlay_nics;
PostSetupCLI.prototype.do_ha_binder = require('./ha-binder').do_ha_binder;
PostSetupCLI.prototype.do_ha_binder.hiddenAliases = ['zookeeper'];
PostSetupCLI.prototype.do_ha_manatee = require('./ha-manatee').do_ha_manatee;
PostSetupCLI.prototype.do_fabrics = require('./fabrics').do_fabrics;

PostSetupCLI.prototype.do_dev_headnode_prov =
    require('./dev-headnode-prov').do_dev_headnode_prov;
PostSetupCLI.prototype.do_dev_sample_data =
    require('./dev-sample-data').do_dev_sample_data;

PostSetupCLI.prototype.do_docker = require('./docker').do_docker;
PostSetupCLI.prototype.do_cmon = require('./cmon').do_cmon;
PostSetupCLI.prototype.do_cns = require('./cns').do_cns;
PostSetupCLI.prototype.do_volapi = require('./volapi').do_volapi;
PostSetupCLI.prototype.do_logarchiver = require('./logarchiver').do_logarchiver;
PostSetupCLI.prototype.do_kbmapi = require('./kbmapi').do_kbmapi;
PostSetupCLI.prototype.do_prometheus = require('./prometheus').do_prometheus;
PostSetupCLI.prototype.do_grafana = require('./grafana').do_grafana;

// --- exports

module.exports = {
    PostSetupCLI: PostSetupCLI
};
