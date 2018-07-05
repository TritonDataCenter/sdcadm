/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup cloudapi'
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var svcadm = require('../svcadm');

// --- internal support stuff


function createCloudapiInstance(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.func(callback, 'callback');

    var progress = opts.progress;
    var sdcadm = opts.sdcadm;
    var sapi = opts.sdcadm.sapi;

    var cloudapisvc;

    // find cloudapi service, get service uuid
    // use sapi.createInstance to create the service

    vasync.pipeline({ arg: {}, funcs: [
        function (_, next) {
            sapi.listServices({ name: 'cloudapi' }, function (err, svcs) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                if (svcs.length !== 1) {
                    next(new Error('expected 1 cloudapi service, found %d',
                        svcs.length));
                    return;
                }
                cloudapisvc = svcs[0];
                next();
            });
        },
        function getHeadnode(ctx, next) {
            sdcadm.getCurrServerUuid(function (err, hn) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.headnodeUuid = hn;
                next();
            });
        },
        function (ctx, next) {
            var cOpts = {
                params: {
                    server_uuid: ctx.headnodeUuid,
                    alias: opts.alias
                }
            };
            sapi.createInstance(cloudapisvc.uuid, cOpts, function (err, _inst) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                    return;
                }
                next();
            });
        },
        function hupHermes(_, next) {
            svcadm.restartHermes({
                sdcadm: sdcadm,
                log: sdcadm.log,
                progress: progress
            }, next);
        }
    ] }, function (err) {
        if (!err) {
            progress('cloudapi0 zone created');
        }
        callback(err);
    });
}

function Cloudapi() {}

Cloudapi.prototype.name = 'cloudapi';
Cloudapi.prototype.help = (
    'Create a first cloudapi instance.\n' +
    '\n' +
    'Initial setup of SmartDataCenter does not create a cloudapi instance.\n' +
    'This procedure will do that for you.\n'
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

    function onInstances(err, insts) {
        if (err) {
            cb(err);
            return;
        }

        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].instance, insts[0].alias);
            cb();
            return;
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].instance, insts[0].alias);
            cb();
            return;
        }

        createCloudapiInstance({
            alias: 'cloudapi0',
            progress: progress,
            sdcadm: sdcadm
        }, cb);
    }

    sdcadm.listInsts({svcs: ['cloudapi']}, onInstances);
};



// --- CLI

function do_cloudapi(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    var proc = new Cloudapi();

    function setupCloudapi(options, callback) {
        proc.execute(options, callback);
    }

    function setupCloudapiCb(err) {
        if (err) {
            self.top.progress('CloudAPI setup failed');
            cb(err);
            return;
        }
        cb();
    }

    common.execWithRetries({
        func: setupCloudapi,
        cb: setupCloudapiCb,
        args: {
            sdcadm: this.sdcadm,
            log: this.log.child({postSetup: 'cloudapi'}, true),
            progress: self.top.progress
        },
        log: self.log,
        retries: opts.retries
    });


}

do_cloudapi.help = (
    Cloudapi.prototype.help +
    '\n' +
    'Usage:\n' +
    '     {{name}} cloudapi\n'
);

do_cloudapi.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];



// --- exports

module.exports = {
    do_cloudapi: do_cloudapi
};
