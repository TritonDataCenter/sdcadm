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
var SdcAdm = require('./sdcadm');



//---- globals

var pkg = require('../package.json');
var log = bunyan.createLogger({
    name: pkg.name,
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
            {names: ['verbose', 'v'], type: 'bool',
                help: 'Verbose/debug output.'}
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

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(this, opts, args, function (err) {
        if (err || err === false) {
            return callback(err);
        }
        self.sdcadm = new SdcAdm({log: log});
        self.sdcadm.init(callback);
    });
};



CLI.prototype.do_self_update = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 1) {
        return callback(new Error('too many args: ' + args));
    }

    this.sdcadm.selfUpdate(callback);
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



CLI.prototype.do_versions = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new Error('too many args: ' + args));
    }

    // TODO: event emitter and node-tab with set widths to stream out versions.
    self.sdcadm.gatherComponentVersions({}, function (err, versions) {
        if (err) {
            return callback(err);
        }
        common.sortArrayOfObjects(versions, opts.s.split(','));
        if (opts.json) {
            console.log(JSON.stringify(versions, null, 4));
        } else {
            var validFields = {};
            versions.forEach(function (v) {
                for (k in v) {
                    validFields[k] = true;
                }
            });
            common.tabulate(versions, {
                skipHeader: opts.H,
                columns: opts.o,
                validFields: Object.keys(validFields).join(',')
            });
        }
        callback();
    });
};
CLI.prototype.do_versions.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'component,version',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,role,component',
        help: 'Sort on the given fields. Default is "-type,role,component".',
        helpArg: 'field1,...'
    },
];
CLI.prototype.do_versions.help = (
    'Show the version of all installed SDC components.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} versions\n'
    + '\n'
    + '{{options}}'
);



//---- exports

module.exports = CLI;
