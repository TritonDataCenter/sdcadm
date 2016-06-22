/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * 'sdcadm post-setup cloudapi'
 */

var p = console.log;
var assert = require('assert-plus');

var common = require('../common');

//---- internal support stuff

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
            return cb(err);
        }

        log.info({insts: insts}, '%d existing cloudapi insts', insts.length);
        if (insts.length === 1) {
            progress('Already have a cloudapi: vm %s (%s)',
                insts[0].instance, insts[0].alias);
            return cb();
        } else if (insts.length > 1) {
            progress('Already have %d cloudapi instances: vm %s (%s), ...',
                insts.length, insts[0].instance, insts[0].alias);
            return cb();
        }

        sdcadm.createCloudapiInstance({
            alias: 'cloudapi0',
            progress: progress
        }, cb);
    }

    sdcadm.listInsts({svcs: ['cloudapi']}, onInstances);
};



//---- CLI

function do_cloudapi(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var proc = new Cloudapi();

    function setupCloudapi(options, callback) {
        proc.execute(options, callback);
    }

    function setupCloudapiCb(err) {
        if (err) {
            self.top.progress('CloudAPI setup failed');
            return cb(err);
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



//---- exports

module.exports = {
    do_cloudapi: do_cloudapi
};
