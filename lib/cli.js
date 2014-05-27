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
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');


var common = require('./common');
var logging = require('./logging');
var SdcAdm = require('./sdcadm');



//---- globals

var pkg = require('../package.json');



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

CLI.prototype.init = function init(opts, args, callback) {
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
        process.env.DEBUG = 1;
    }

    // Setup the logger.
    var handler = this.handlerFromSubcmd(args[0]);
    var logComponent = args[0] || 'nosubcmd';
    if (handler) {
        assert.ok(handler.name && handler.name.length > 0,
            format('<handler>.name for subcmd "%s"', args[0]));
        logComponent = handler.name.slice(3);
    }
    var logToFile = (handler && handler.logToFile || false);
    this.log = logging.createLogger({
        name: pkg.name,
        component: logComponent,    // typically the subcmd name
        logToFile: logToFile,       // whether to always log to a file
        verbose: Boolean(opts.verbose)
    })

    // Log the invocation args (trim out dashdash meta vars).
    var trimmedOpts = common.objCopy(opts);
    delete trimmedOpts._args;
    delete trimmedOpts._order;
    this.log.debug({opts: trimmedOpts, args: args}, 'cli init')

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(this, opts, args, function (err) {
        if (err || err === false) {
            return callback(err);
        }
        self.sdcadm = new SdcAdm({log: self.log});
        self.sdcadm.init(callback);
    });
};



CLI.prototype.do_self_update = function do_self_update(subcmd, opts,
                                                       args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 1) {
        return callback(new errors.UsageError('too many args: ' + args));
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
CLI.prototype.do_self_update.logToFile = true;



/**
 * $ sdcadm insts
 * SERVICE  HOSTNAME  IMAGE/VERSION   ZONENAME   ALIAS
 */
CLI.prototype.do_instances = function do_instances(subcmd, opts, args,
                                                   callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    self.sdcadm.getInstances({}, function (err, insts) {
        if (err) {
            return callback(err);
        }
        common.sortArrayOfObjects(insts, opts.s.split(','));
        if (opts.json) {
            console.log(JSON.stringify(insts, null, 4));
        } else {
            var validFields = 'type,service,instance,zonename,alias,version,image,server,hostname,image/version';
            insts.forEach(function (inst) {
                inst['image/version'] = inst.image || inst.version;
            });
            common.tabulate(insts, {
                skipHeader: opts.H,
                columns: opts.o,
                validFields: validFields
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
CLI.prototype.do_services = function do_services(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    // XXX this should `.getServices()` as well to report services with
    //     no instances.

    self.sdcadm.getInstances({}, function (err, insts) {
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


CLI.prototype.do_update = function do_update(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 1) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    p('WARNING: This is pre-alpha. Don\'t use this for production yet.');

    var changes;
    var plan;
    var execStart;
    vasync.pipeline({funcs: [
        function getSpecFromArgs(_, next) {
            if (args.length !== 1) {
                return next();
            }
            var svc = args[0];
            changes = [{
                service: svc,
            }];
            if (opts.image) {
                changes[0].image = opts.image;
            }
            next();
        },
        function getSpecFromStdin(_, next) {
            if (args.length !== 0) {
                return next();
            } else if (process.stdin.isTTY) {
                return next(new errors.UsageError(
                    'will not take input from stdin when stdin is a TTY'));
            }
            var chunks = [];
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable', function (chunk) {
                var chunk = process.stdin.read();
                if (chunk) {
                    chunks.push(chunk);
                }
            });
            process.stdin.on('end', function() {
                try {
                    changes = JSON.parse(chunks.join(''));
                } catch (ex) {
                    return next(new errors.UsageError(ex,
                        "input is not valid JSON"));
                }
                if (!Array.isArray(changes)) {
                    changes = [changes];
                }
                next();
            });
        },

        //XXX acquireLock
        function genPlan(_, next) {
            self.sdcadm.genUpdatePlan({
                changes: changes,
                logCb: console.log,
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            p('')
            p('This update will make the following changes:')
            self.sdcadm.summarizePlan({plan: plan, logCb: console.log});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting update');
                    return cb();
                }
                p('');
                next();
            });
        },
        function execPlan(_, next) {
            execStart = Date.now();
            if (opts.dry_run) {
                p('[dry-run] done')
                return next();
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                logCb: console.log,
                dryRun: opts.dry_run
            }, next);
        }
    ]}, function finishUp(err) {
        // XXX unlock
        if (!err) {
            p('Updated successfully (elapsed %ds).',
                Math.floor((Date.now() - execStart) / 1000));
        }
        cb(err);
    });
};
CLI.prototype.do_update.options = [
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
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        helpArg: '<uuid>',
        help: 'Image UUID to use for update. Only valid when <service> is '
            + 'provided.'
    }
];
CLI.prototype.do_update.help = (
    'Update the given parts of SDC.\n'
    + '\n'
    + 'Usage:\n'
    + '     ...update spec on stdin... | {{name}} update [<options>]\n'
    + '     {{name}} update [<options>] <service>\n'
    + '\n'
    + 'Examples:\n'
    + '     # Update all instances of the cnapi service to the latest\n'
    + '     # available image.\n'
    + '     {{name}} update cnapi\n'
    + '\n'
    + '     TODO: spec other inputs\n'
    + '{{options}}'
);
CLI.prototype.do_update.logToFile = true;



//---- exports

module.exports = CLI;


//---- mainline

if (require.main === module) {
    /**
     * Dev Note: Would like to just do this:
     *      cmdln.main(CLI, process.argv, {showCode: true});
     * but first I'd want cmdln.js to support:
     * - a finalize that is called before the error printing to console.error
     *   so we can logging.flushLogs, log.error, etc.
     */
    var cli = new CLI();
    cli.main(process.argv, function (err, subcmd) {
        if (err) {
            var exitStatus = err.exitStatus || 1;
            cli.log.error({err: err, subcmd: subcmd, exitStatus: exitStatus},
                'cli exit');

            // If the `err` has no "message" field, then this probably isn't
            // and Error instance. Let's just not print an error message. This
            // can happen if the subcmd passes back `true` or similar to
            // indicate "yes there was an error".
            if (err.message !== undefined) {
                var code = (err.body ? err.body.code : err.code);
                console.error('%s%s: error%s: %s',
                    cli.name,
                    (subcmd ? ' ' + subcmd : ''),
                    (code ? format(' (%s)', code) : ''),
                    (process.env.DEBUG ? err.stack : err.message));
            }
            process.exit(exitStatus);
        }
        cli.log.debug({subcmd: subcmd, exitStatus: 0}, 'cli exit');
    });
}
