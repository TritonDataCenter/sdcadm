/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Collecting 'sdcadm experimental ...' CLI commands.
 *
 * These are temporary, unsupported commands for running SDC updates before
 * the grand plan of 'sdcadm update' fully handling updates is complete.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;

var jsprim = require('jsprim');
var schemas = require('joyent-schemas');
var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');
var svcadm = require('../svcadm');

var DCMaintCLI = require('../dc-maint').DCMaintCLI;


//---- globals


//---- Experimental CLI class

function ExperimentalCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm experimental',
        desc: 'Experimental, unsupported, temporary sdcadm commands.\n' +
              '\n' +
              'These are unsupported and temporary commands to assist with\n' +
              'migration away from incr-upgrade scripts. The eventual\n' +
              'general upgrade process will not include any commands under\n' +
              '"sdcadm experimental".',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(ExperimentalCLI, Cmdln);

ExperimentalCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


ExperimentalCLI.prototype.do_update_agents =
require('./do_update_agents').do_update_agents;

// TOOLS-905: This is deprecated, the command has been moved
// out of experimental and it's just here to warn users about
// that fact. Remove after one month since Nov. the 25th.
ExperimentalCLI.prototype.do_dc_maint = DCMaintCLI;

ExperimentalCLI.prototype.do_update_other =
require('./do_update_other').do_update_other;


ExperimentalCLI.prototype.do_update_gz_tools =
require('./do_update_gz_tools').do_update_gz_tools;


ExperimentalCLI.prototype.do_add_new_agent_svcs =
require('./do_add_new_agent_svcs').do_add_new_agent_svcs;


ExperimentalCLI.prototype.do_update_docker =
require('./do_update_docker').do_update_docker;

ExperimentalCLI.prototype.do_install_docker_cert =
require('./do_install_docker_cert').do_install_docker_cert;

ExperimentalCLI.prototype.do_cns =
require('./do_cns').do_cns;

ExperimentalCLI.prototype.do_volapi =
require('./do_volapi').do_volapi;


//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
