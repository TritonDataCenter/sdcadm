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


/*
ExperimentalCLI.prototype.do_foo = function do_foo(subcmd, opts, args, cb) {
    p('experimental foo')
    cb();
};
ExperimentalCLI.prototype.do_foo.help = (
    'foo\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} foo [<options>]\n'
    + '\n'
    + '{{options}}'
);
*/



//---- exports

module.exports = {
    ExperimentalCLI: ExperimentalCLI
};
