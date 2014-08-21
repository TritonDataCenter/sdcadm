/**
 *
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * * *
 *
 * A library to exec `svcadm` commands.
 */

var p = console.log;

var assert = require('assert-plus');
var async = require('async');
var child_process = require('child_process'),
    execFile = child_process.execFile,
    spawn = child_process.spawn;
var format = require('util').format;

var common = require('./common'),
    execFilePlus = common.execFilePlus;
var errors = require('./errors'),
    InternalError = errors.InternalError;



/**
 * Call `svcadm enable FMRI`.
 *
 * @param args {Object}
 *      - fmri {Array | String} Optional. The SMF service FMRI(s) to enable.
 *      - wait {Boolean} Optional. Set to true to wait for each service to
 *        enter 'enabled' or 'degraded' state. Corresponds to '-s' option to
 *        `svcadm enable`.
 *      - zone {String} Optional. Administer services in the specified zone.
 *        Only valid if called from the global zone.
 *      - verbose {Boolean} Optional. Verbose stdout output.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err)`
 */
function svcadmEnable(args, cb) {
    assert.object(args, 'args');
    var fmri = (args.fmri && !Array.isArray(args.fmri)
        ? [args.fmri] : args.fmri);
    assert.optionalArrayOfString(fmri, 'args.fmri');
    assert.optionalBool(args.wait, 'args.wait');
    assert.optionalString(args.zone, 'args.zone');
    assert.optionalBool(args.verbose, 'args.verbose');
    assert.object(args.log, 'args.log');
    assert.func(cb);

    var argv = ['/usr/sbin/svcadm'];
    if (args.zone) {
        argv.push('-z');
        argv.push(args.zone);
    }
    if (args.verbose) {
        argv.push('-v');
    }
    argv.push('enable');
    if (args.wait) {
        argv.push('-s');
    }
    if (fmri.length) {
        argv = argv.concat(fmri);
    }

    execFilePlus({argv: argv, log: args.log}, cb);
}



/**
 * Call `svcadm disable FMRI`.
 *
 * @param args {Object}
 *      - fmri {Array | String} Optional. The SMF service FMRI(s) to disable.
 *      - wait {Boolean} Optional. Set to true to wait for each service to
 *        enter 'disabled' state. Corresponds to '-s' option to
 *        `svcadm disable`.
 *      - zone {String} Optional. Administer services in the specified zone.
 *        Only valid if called from the global zone.
 *      - verbose {Boolean} Optional. Verbose stdout output.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err)`
 */
function svcadmDisable(args, cb) {
    assert.object(args, 'args');
    var fmri = (args.fmri && !Array.isArray(args.fmri)
        ? [args.fmri] : args.fmri);
    assert.optionalArrayOfString(fmri, 'args.fmri');
    assert.optionalBool(args.wait, 'args.wait');
    assert.optionalString(args.zone, 'args.zone');
    assert.optionalBool(args.verbose, 'args.verbose');
    assert.object(args.log, 'args.log');
    assert.func(cb);

    var argv = ['/usr/sbin/svcadm'];
    if (args.zone) {
        argv.push('-z');
        argv.push(args.zone);
    }
    if (args.verbose) {
        argv.push('-v');
    }
    argv.push('disable');
    if (args.wait) {
        argv.push('-s');
    }
    if (fmri.length) {
        argv = argv.concat(fmri);
    }

    execFilePlus({argv: argv, log: args.log}, cb);
}




// ---- exports

module.exports = {
    svcadmEnable: svcadmEnable,
    svcadmDisable: svcadmDisable
};
