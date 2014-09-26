/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Collecting 'sdcadm post-setup ...' CLI commands.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var cp = require('child_process');
var execFile = cp.execFile;
var spawn = cp.spawn;
var sprintf = require('extsprintf').sprintf;
var tabula = require('tabula');

var vasync = require('vasync');
var read = require('read');
var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var errors = require('./errors');



//---- globals



//---- post-setup procedures

function Cloudapi() {}
Cloudapi.prototype.name = 'cloudapi';
Cloudapi.prototype.help = (
    'Create a first cloudapi instance.\n'
    + '\n'
    + 'Initial setup of SmartDataCenter does not create a cloudapi instance.\n'
    + 'This procedure will do that for you.\n'
);
Cloudapi.prototype.execute = function cExecute(options, cb) {
    assert.object(options, 'options');
    assert.object(options.sdcadm, 'options.sdcadm');
    assert.object(options.log, 'options.log');
    assert.func(options.progress, 'options.progress');
    assert.func(cb, 'cb');

    var log = options.log;
    var sdcadm = options.sdcadm;
    var progress = options.progress;

    p('TODO: implement Cloudapi.execute()');

    log.info('check for existing cloudapi instance');
    // XXX implement these args to listInstances (rename from getInstances)
    sdcadm.listInstances({application: 'sdc', service: 'cloudapi'},
            function (err, insts) {
        if (err) {
            return cb(err);
        }
        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].uuid, insts[0].alias);
            return cb();
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].uuid, insts[0].alias);
            return cb();
        }

        cb(new Error('TODO'));
        // TODO:
        // - get create instance working
        //      sdcadm.sapi.createInstance({})
        // - better doc https://mo.joyent.com/docs/sapi/master/#CreateInstance
        //   response example
        // - add sapi.createInstanceAndWait if this doesn't wait
    });

//    vmadm lookup -1 alias=cloudapi0 2>/dev/null >/dev/null && return
//    echo "# Provision cloudapi"
//    cat <<EOM | sapiadm provision
//{
//    "service_uuid": "$(sdc-sapi /services?name=cloudapi | json -H 0.uuid)",
//    "params": {
//        "alias": "cloudapi0",
//        "networks": [
//            {
//              "uuid": "$(sdc-napi /networks?name=admin | json -H 0.uuid)"
//            },
//            {
//              "uuid": "$(sdc-napi /networks?name=external | json -H 0.uuid)",
//              "primary": true
//            }
//        ]
//    }
//}
//EOM

    cb();
};

function CommonExternalNics() {}
CommonExternalNics.prototype.name = 'common-external-nics';
CommonExternalNics.prototype.help = (
    'Add external NICs to the adminui and imgapi zones.\n'
    + '\n'
    + 'By default no SDC core zones are given external nics in initial\n'
    + 'setup. Typically it is most useful to have those for the adminui\n'
    + 'instance (to be able to access the operator portal in your browser)\n'
    + 'and for the imgapi instance (to enable it to reach out to \n'
    + 'updates.joyent.com and images.joyent.com for images). IMGAPI\n'
    + 'instances are always firewalled such that only outbound connections\n'
    + 'are allowed.\n'
);
CommonExternalNics.prototype.execute = function (options, cb) {
    p('TODO: implement CommonExternalNics.execute()');
    cb(new Error('TODO'));
};



//---- PostSetup CLI class

function PostSetupCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm post-setup',
        desc: 'Common post-setup procedures.\n'
            + '\n'
            + 'The default setup of a SmartDataCenter headnode is somewhat\n'
            + 'minimal. "Everything up to adminui." Practical usage of\n'
            + 'SDC -- whether for production, development or testing --\n'
            + 'involves a number of common post-setup steps. This command\n'
            + 'attempts to capture many of those for convenience and\n'
            + 'consistency.\n',
        helpOpts: {
            minHelpCol: 26
        }
    });
}
util.inherits(PostSetupCLI, Cmdln);

PostSetupCLI.prototype.init = function init(opts, args, cb) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


PostSetupCLI.prototype.do_cloudapi =
        function do_cloudapi(subcmd, opts, args, cb) {
    var proc = new Cloudapi();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'cloudapi'}, true),
            progress: this.progress
        }, cb);
};
PostSetupCLI.prototype.do_cloudapi.help = (Cloudapi.prototype.help
    + '\n'
    + 'Usage:\n'
    + '     {{name}} cloudapi\n'
);

PostSetupCLI.prototype.do_common_external_nics =
        function do_common_external_nics(subcmd, opts, args, cb) {
    var proc = new CommonExternalNics();
    proc.execute({
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'common-external-nics'}, true),
            progress: this.progress
        }, cb);
};
PostSetupCLI.prototype.do_common_external_nics.help = (Cloudapi.prototype.help
    + '\n'
    + 'Usage:\n'
    + '     {{name}} common-external-nics\n'
);



//---- exports

module.exports = {
    PostSetupCLI: PostSetupCLI
};
