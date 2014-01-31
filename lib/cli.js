/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * The 'sdcadm' CLI class.
 */

var p = console.log;
var e = console.error;
var util = require('util'),
    format = util.format;
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec;
var fs = require('fs');


var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var sprintf = require('extsprintf').sprintf;

var common = require('./common');
var SDCADM = require('./sdcadm');



//---- globals

var pkg = require('../package.json');
var name = 'sdcadm';
var log = bunyan.createLogger({
    name: name,
    serializers: bunyan.stdSerializers,
    stream: process.stderr,
    level: 'warn'
});


//---- CLI class

function CLI() {
    Cmdln.call(this, {
        name: pkg.name,
        desc: pkg.description,
        options: [
            {names: ['help', 'h'], type: 'bool', help: 'Print help and exit.'},
            {name: 'version', type: 'bool', help: 'Print version and exit.'},
            {names: ['verbose', 'v'], type: 'bool', help: 'Verbose/debug output.'}
        ],
        helpOpts: {
            includeEnv: true,
            minHelpCol: 23 /* line up with option help */
        }
    });
}
util.inherits(CLI, Cmdln);

CLI.prototype.init = function (opts, args, callback) {
    var self = this;

    if (opts.version) {
        p(this.name, pkg.version);
        callback(false);
        return;
    }
    this.opts = opts;
    if (opts.verbose) {
        log.level('trace');
        log.src = true;
    }

    this.__defineGetter__('sdcadm', function () {
        if (self._sdcadm === undefined) {
            self._sdcadm = new SDCADM({log: log});
        }
        return self._sdcadm;
    });

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.apply(this, arguments);
};



CLI.prototype.do_self_update = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 1) {
        return callback(new Error('too many args: ' + args));
    }

    this.sdcadm.selfUpdate({
        log: log
    }, callback);
};
CLI.prototype.do_self_update.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually updating.'
    }
];
CLI.prototype.do_self_update.help = (
    'Update "sdcadm" itself.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} self-update\n'
    + '\n'
    + '{{options}}'
);




//---- exports

module.exports = CLI;
