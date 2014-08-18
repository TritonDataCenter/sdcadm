/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * Collecting 'sdcadm experimental ...' CLI commands.
 *
 * These are temporary, unsupported commands for running SDC updates before
 * the grand plan of 'sdcadm update' fully handling updates is complete.
 */

var p = console.log;
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;


var common = require('./common');
var errors = require('./errors');



//---- globals



//---- Experimental CLI class

function ExperimentalCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm experimental',
        desc: 'Experimental, unsupported, temporary sdcadm commands.\n'
            + '\n'
            + 'These are unsupported and temporary commands to assist with\n'
            + 'migration away from incr-upgrade scripts. The eventual\n'
            + 'general upgrade process will not include any commands under\n'
            + '"sdcadm experimental".',
        helpOpts: {
            minHelpCol: 23 /* line up with option help */
        }
    });
}
util.inherits(ExperimentalCLI, Cmdln);

ExperimentalCLI.prototype.init = function init(opts, args, callback) {
    this.sdcadm = this.top.sdcadm;
    this.logCb = this.top.logCb;
    Cmdln.prototype.init.apply(this, arguments);
};


//ExperimentalCLI.prototype.do_foo = function do_foo(subcmd, opts, args, cb) {
//    p('experimental foo')
//    cb();
//};
//ExperimentalCLI.prototype.do_foo.help = (
//    'foo\n'
//    + '\n'
//    + 'Usage:\n'
//    + '     {{name}} foo [<options>]\n'
//    + '\n'
//    + '{{options}}'
//);


ExperimentalCLI.prototype.do_dc_maint = function do_dc_maint(
        subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    if (opts.start && opts.stop) {
        cb(new errors.UsageError('cannot use --start and --stop'));
    } else if (opts.start) {
        this.sdcadm.dcMaintStart({logCb: self.logCb}, cb);
    } else if (opts.stop) {
        this.sdcadm.dcMaintStop({logCb: self.logCb}, cb);
    } else {
        this.sdcadm.dcMaintStatus(function (err, status) {
            if (err) {
                return cb(err);
            }
            self.logCb(status);
            cb();
        });
    }
    cb();
};
ExperimentalCLI.prototype.do_dc_maint.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['start'],
        type: 'bool',
        help: 'Start maintenance mode.'
    },
    {
        names: ['stop'],
        type: 'bool',
        help: 'Stop maintenance mode (i.e. restore DC to full operation).'
    }
];
ExperimentalCLI.prototype.do_dc_maint.help = (
    'Show and modify the DC maintenance mode.\n'
    + '\n'
    + '"Maintenance mode for an SDC means that Cloud APi is in read-only\n'
    + 'mode. Modifying requests will return "503 Service Unavailable".\n'
    + 'Workflow API will be drained on entering maint mode.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} dc-maint [<options>]\n'
    + '\n'
    + '{{options}}'
);



//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
