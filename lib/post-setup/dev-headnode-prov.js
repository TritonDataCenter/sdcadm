/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2024 MNX Cloud, Inc.
 */

/*
 * 'sdcadm post-setup dev-headnode-prov'
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');
var svcadm = require('../svcadm');


// --- internal support stuff

function makeHeadnodeProvisionable(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.progress, 'opts.progress');
    assert.func(cb, 'cb');

    var log = opts.log;
    var sdcadm = opts.sdcadm;
    var progress = opts.progress;

    vasync.pipeline({arg: {}, funcs: [
        function getCnapiSvc(ctx, next) {
            sdcadm.getSvc({app: 'sdc', svc: 'cnapi'}, function (err, cnapi) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.cnapi = cnapi;
                next();
            });
        },
        function tweakCnapiConfig(ctx, next) {
            if (ctx.cnapi.metadata.ALLOC_FILTER_CAPNESS === false &&
                ctx.cnapi.metadata.ALLOC_FILTER_HEADNODE === false &&
                ctx.cnapi.metadata.ALLOC_FILTER_MIN_RESOURCES === false) {
                progress('CNAPI is already configured to allow headnode ' +
                    'provisioning and over-provisioning');
                ctx.alreadyDone = true;
                next();
                return;
            }

            progress('Configuring CNAPI to allow headnode provisioning' +
                ' and over-provisioning');
            var update = {
                metadata: {
                    ALLOC_FILTER_CAPNESS: false,
                    ALLOC_FILTER_HEADNODE: false,
                    ALLOC_FILTER_MIN_RESOURCES: false
                }
            };
            sdcadm.sapi.updateService(ctx.cnapi.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function getCnapiInsts(ctx, next) {
            if (ctx.alreadyDone) {
                next();
                return;
            }

            var listOpts = {types: ['vm'], svcs: ['cnapi']};
            sdcadm.listInsts(listOpts, function (err, insts) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.cnapiInsts = insts;
                log.trace({cnapiInsts: ctx.cnapiInsts}, 'cnapiInsts');
                next();
            });
        },

        function updatesCnapiInsts(ctx, next) {
            if (ctx.alreadyDone) {
                next();
                return;
            }

            var queue = vasync.queue(
                function refreshCnapiInst(inst, nextInst) {
                    progress('Refreshing instance %s config-agent', inst.alias);
                    svcadm.svcadmRefresh({
                        server_uuid: inst.server,
                        zone: inst.instance,
                        wait: true,
                        fmri: 'config-agent',
                        sdcadm: sdcadm,
                        log: log
                    }, nextInst);
                },
                10);
            queue.push(ctx.cnapiInsts);
            queue.close();
            queue.on('end', function done() {
                next();
            });
        }
    ]}, cb);
}


// --- CLI

function do_dev_headnode_prov(subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    makeHeadnodeProvisionable({
        sdcadm: this.sdcadm,
        log: this.log.child({postSetup: 'dev-headnode-prov'}, true),
        progress: this.top.progress
    }, cb);
}

do_dev_headnode_prov.help = (
    'Make the headnode provisionable, for development and testing.\n' +
    '\n' +
    'This is done via `ALLOC_FILTER_CAPNESS`, `ALLOC_FILTER_HEADNODE`, and \n' +
    '`ALLOC_FILTER_MIN_RESOURCES` SAPI parameters of the CNAPI service.\n' +
    'See https://github.com/TritonDataCenter/sdc-cnapi/blob/master/docs/index.md#sapi-configuration\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} dev-headnode-prov\n'
);

do_dev_headnode_prov.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

do_dev_headnode_prov.logToFile = true;

// --- exports

module.exports = {
    do_dev_headnode_prov: do_dev_headnode_prov
};
