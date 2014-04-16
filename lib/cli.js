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
var path = require('path');


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
        var buildstampPath = path.resolve(__dirname, '..', 'etc',
            'buildstamp');
        fs.readFile(buildstampPath, 'utf8', function (err, data) {
            if (err) {
                return next(err);
            }
            var buildstamp = data.trim();
            p('%s %s (%s)', self.name, pkg.version, buildstamp);
            callback(false);
        });
        return;
    }
    this.opts = opts;
    if (opts.verbose) {
        log.level('trace');
        log.src = true;
        // LAME: Trigger the cmdln.main printing the full traceback on error.
        process.env.DEBUG = 1;
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

    this.sdcadm.selfUpdate({
        logCb: console.log,
        allowMajorUpdate: opts.allow_major_update,
        dryRun: opts.dry_run
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
    },
    {
        names: ['allow-major-update'],
        type: 'bool',
        help: 'Allow a major version update to sdcadm. By default major '
            + 'updates are skipped (to avoid accidental backward '
            + 'compatibility breakage).'
    }
];
CLI.prototype.do_self_update.help = (
    'Update "sdcadm" itself.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} self-update [<options>]\n'
    + '\n'
    + '{{options}}'
);



/**
 * $ sdcadm insts
 * SERVICE  HOSTNAME  IMAGE/VERSION   ZONENAME   ALIAS
 */
CLI.prototype.do_instances = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new Error('too many args: ' + args));
    }

    self.sdcadm.getServiceInstances({}, function (err, insts) {
        if (err) {
            return callback(err);
        }
        common.sortArrayOfObjects(insts, opts.s.split(','));
        if (opts.json) {
            console.log(JSON.stringify(insts, null, 4));
        } else {
            var validFields = {};
            insts.forEach(function (inst) {
                inst['image/version'] = inst.image || inst.version;
                for (k in inst) {
                    validFields[k] = true;
                }
            });
            common.tabulate(insts, {
                skipHeader: opts.H,
                columns: opts.o,
                validFields: Object.keys(validFields).join(',')
            });
        }
        callback();
    });
};
CLI.prototype.do_instances.options = [
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
        default: 'service,hostname,image/version,zonename,alias',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,service,hostname,version',
        help: 'Sort on the given fields. Default is "-type,service,hostname,version".',
        helpArg: 'field1,...'
    },
];
CLI.prototype.do_instances.aliases = ['insts'];
CLI.prototype.do_instances.help = (
    'List all SDC service instances.\n'
    + 'Note that "service" here includes SDC core zones and agents.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} instances [<options>]\n'
    + '\n'
    + '{{options}}'
);



/**
 * $ sdcadm svcs
 * SERVICE     IMAGE/VERSION    COUNT
 */
CLI.prototype.do_services = function (subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new Error('too many args: ' + args));
    }

    self.sdcadm.getServiceInstances({}, function (err, insts) {
        if (err) {
            return callback(err);
        }

        // Group by service/image-or-version.
        var rowFromSvcImg = {};
        for (var i = 0; i < insts.length; i++) {
            var inst = insts[i];
            var imgOrVer = inst.image || inst.version;
            var key = inst.service + ':' + imgOrVer;
            if (!rowFromSvcImg[key]) {
                rowFromSvcImg[key] = {
                    type: inst.type,
                    service: inst.service,
                    image: inst.image,
                    version: inst.version,
                    'image/version': imgOrVer,
                    count: 1
                };
            } else {
                rowFromSvcImg[key].count++;
            }
        }

        var rows = Object.keys(rowFromSvcImg).map(
                function (k) { return rowFromSvcImg[k]; });
        common.sortArrayOfObjects(rows, opts.s.split(','));

        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
        } else {
            var validFields = {};
            rows.forEach(function (v) {
                for (k in v) {
                    validFields[k] = true;
                }
            });
            common.tabulate(rows, {
                skipHeader: opts.H,
                columns: opts.o,
                validFields: Object.keys(validFields).join(',')
            });
        }
        callback();
    });
};
CLI.prototype.do_services.options = [
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
        default: 'service,image,version,count',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,service,server',
        help: 'Sort on the given fields. Default is "-type,service,server".',
        helpArg: 'field1,...'
    },
];
CLI.prototype.do_services.aliases = ['svcs'];
CLI.prototype.do_services.help = (
    'List all SDC services with version and count details.\n'
    + '\n'
    + 'The list includes a row for every unique (<service>, <version>). So,\n'
    + 'if there are two manatees at one version, and another at a different\n'
    + 'version, then two rows will be shown.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} services [<options>]\n'
    + '\n'
    + '{{options}}'
);



//---- exports

module.exports = CLI;


//---- mainline

if (require.main === module) {
    cmdln.main(CLI, process.arg, {showCode: true});
}
