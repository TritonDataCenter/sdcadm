/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
var strsplit = require('strsplit');
var tabula = require('tabula');
var vasync = require('vasync');


var common = require('./common');
var errors = require('./errors');
var logging = require('./logging');
var SdcAdm = require('./sdcadm');
var experimental = require('./experimental');



//---- globals

var pkg = require('../package.json');
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



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

    // Setup the logger.
    var handler = this.handlerFromSubcmd(args[0]);
    var logComponent = args[0] || 'nosubcmd';
    if (handler && handler.name && handler.name.slice(0, 3) === 'do_') {
        // Use this to canonicalize the name, e.g. if args[0] is 'insts',
        // but the command is canonically 'instances'.
        logComponent = handler.name.slice(3);
    }
    var logToFile = (handler && handler.logToFile || false);
    this.log = logging.createLogger({
        name: pkg.name,
        component: logComponent,    // typically the subcmd name
        logToFile: logToFile,       // whether to always log to a file
        verbose: Boolean(opts.verbose)
    });

    // Log the invocation args (trim out dashdash meta vars).
    var trimmedOpts = common.objCopy(opts);
    delete trimmedOpts._args;
    delete trimmedOpts._order;
    this.log.debug({opts: trimmedOpts, args: args}, 'cli init');

    if (opts.version) {
        var buildstampPath = path.resolve(__dirname, '..', 'etc',
            'buildstamp');
        fs.readFile(buildstampPath, 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }
            var buildstamp = data.trim();
            p('%s %s (%s)', self.name, pkg.version, buildstamp);
            callback(false);
        });
        return;
    }
    this.opts = opts;
    if (opts.verbose) {   //XXX drop this when switching to cmdln v2
        process.env.DEBUG = 1;
    }

    this.logCb = function cliLogCb(s) {
        self.log.debug({logCb: true}, s);
        console.log(s);
    };

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
    } else if (args.length > 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    this.sdcadm.selfUpdate({
        logCb: this.logCb,
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



CLI.prototype.do_instances = function do_instances(subcmd, opts, args,
                                                   callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    self.sdcadm.getInstances({}, function (err, insts) {
        if (err) {
            return callback(err);
        }

        var rows = insts;
        if (opts.group_by_image) {
            var rowFromTypeSvcImage = {};
            for (var i = 0; i < insts.length; i++) {
                var inst = insts[i];
                // `|| inst.version` necessary until agents and platforms
                // use images.
                var key = [inst.type, inst.service,
                    inst.image || inst.version].join('/');
                if (rowFromTypeSvcImage[key] === undefined) {
                    rowFromTypeSvcImage[key] = {
                        type: inst.type,
                        service: inst.service,
                        version: inst.version,
                        image: inst.image,
                        instances: [inst.instance]
                    };
                } else {
                    rowFromTypeSvcImage[key].instances.push(inst.instance);
                }
            }
            rows = Object.keys(rowFromTypeSvcImage).map(function (k) {
                var row = rowFromTypeSvcImage[k];
                row.count = row.instances.length;
                return row;
            });
            columns = ['service', 'image', 'version', 'count'];
        }

        common.sortArrayOfObjects(rows, sort);
        if (opts.json) {
            console.log(JSON.stringify(rows, null, 4));
        } else {
            tabula(rows, {
                skipHeader: opts.H,
                columns: columns
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
        default: 'instance,service,hostname,version,alias',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,service,hostname,version,alias',
        help: 'Sort on the given fields. Default is ' +
            '"-type,service,hostname,version,alias".',
        helpArg: 'field1,...'
    },
    {
        names: ['group-by-image', 'I'],
        type: 'bool',
        help: 'Group by unique (service, image).'
    }
];
CLI.prototype.do_instances.aliases = ['insts'];
CLI.prototype.do_instances.help = (
    'List all SDC service instances.\n'
    + 'Note that "service" here includes SDC core vms and agents.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} instances [<options>]\n'
    + '\n'
    + '{{options}}'
);


CLI.prototype.do_services = function do_services(subcmd, opts, args, callback) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    var i;
    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);
    var needInsts = opts.json || ~columns.indexOf('insts');

    function getInstsIfNecessary(next) {
        if (!needInsts) {
            return next();
        }
        self.sdcadm.getInstances({}, next);
    }

    getInstsIfNecessary(function (iErr, insts) {
        if (iErr) {
            return callback(iErr);
        }
        self.sdcadm.getServices({}, function (err, svcs) {
            if (err) {
                return callback(err);
            }

            if (needInsts) {
                var countFromSvcName = {};
                for (i = 0; i < insts.length; i++) {
                    var svcName = insts[i].service;
                    if (countFromSvcName[svcName] === undefined) {
                        countFromSvcName[svcName] = 1;
                    } else {
                        countFromSvcName[svcName]++;
                    }
                }
                for (i = 0; i < svcs.length; i++) {
                    svcs[i].insts = countFromSvcName[svcs[i].name] || 0;
                }
            }

            if (opts.json) {
                console.log(JSON.stringify(svcs, null, 4));
            } else {
                var validFieldsMap = {};
                var rows = svcs.map(function (svc) {
                    if (svc.type === 'vm') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: svc.params && svc.params.image_uuid,
                            insts: svc.insts
                        };
                    } else if (svc.type === 'agent') {
                        return {
                            type: svc.type,
                            uuid: svc.uuid,
                            name: svc.name,
                            image: null,
                            insts: svc.insts
                        };
                    } else {
                        self.log.warn({svc: svc}, 'unknown service type');
                    }
                }).filter(function (svc) {
                    // Filter out `undefined` entries.
                    return svc;
                });
                rows.forEach(function (v) {
                    for (var k in v) {
                        validFieldsMap[k] = true;
                    }
                });
                tabula(rows, {
                    skipHeader: opts.H,
                    columns: columns,
                    sort: sort,
                    validFields: Object.keys(validFieldsMap)
                });
            }
            callback();
        });
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
        default: 'type,uuid,name,image,insts',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: '-type,name',
        help: 'Sort on the given fields. Default is "-type,name".',
        helpArg: 'field1,...'
    }
];
CLI.prototype.do_services.aliases = ['svcs'];
CLI.prototype.do_services.help = (
    'List all SDC services.\n'
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
    }

    var unlock;
    var svcs;
    var svcFromName;
    var changes;
    var plan;
    var execStart;
    vasync.pipeline({funcs: [
        /**
         * Also see 'sdcadm update' section in docs/index.md.
         *
         *      sdcadm update <svc> ...
         *      sdcadm update <svc>@<image> ...
         *      sdcadm update <svc>@<version> ...
         *      sdcadm update <inst> ...
         *      sdcadm update <inst>@<image> ...
         *      sdcadm update <inst>@<version> ...
         *      sdcadm -f <upgrade-spec-file.json>
         *      echo <upgrade-spec-file.json> | sdcadm update
         *      sdcadm update -a|--all
         *
         * Where a <svc> is one from `sdcadm.getServices()` and <inst> is one
         * of "<zone-uuid>", "<zone-alias>" or "<server-uuid>/<agent-svc>".
         *
         * TODO: Do we need the stdin option?
         *
         *      [
         *          {"service": "cnapi", "image": "<uuid-or-local-path>"},
         *          {"service": "provisioner", "image": "<uuid-or-local-path>"},
         *          ...
         *      ]
         */
        function getSpecFromStdin(_, next) {
            if (args.length !== 0 || opts.all) {
                return next();
            } else if (process.stdin.isTTY) {
                return next(new errors.UsageError(
                    'If updating all instances, --all is a required option.'));
            }
            var chunks = [];
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable', function () {
                var chunk = process.stdin.read();
                if (chunk) {
                    chunks.push(chunk);
                }
            });
            process.stdin.on('end', function () {
                try {
                    changes = JSON.parse(chunks.join(''));
                } catch (ex) {
                    return next(new errors.UsageError(ex,
                        'input is not valid JSON'));
                }
                if (!Array.isArray(changes)) {
                    changes = [changes];
                }
                next();
            });
        },
        function getLock(_, next) {
            self.sdcadm.acquireLock({logCb: self.logCb},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function getSvcs(_, next) {
            // TODO: get this cached with the same call in `genUpdatePlan`
            self.sdcadm.getServices({}, function (err, svcs_) {
                svcs = svcs_;
                svcFromName = {};
                for (var i = 0; i < svcs.length; i++) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },
        function getSpecFromArgs(_, next) {
            if (args.length === 0) {
                return next();
            }
            changes = [];
            for (var i = 0; i < args.length; i++) {
                var parts = strsplit(args[i], '@', 2);
                var svcOrInst = parts[0];
                var verOrImg;
                if (parts.length > 1) {
                    verOrImg = parts[1];
                }
                var svc = null;
                var inst = null;
                parts = strsplit(svcOrInst, '/', 2);
                if (parts.length > 1) {
                    // server = parts[0];
                    inst = svcOrInst;
                    if (svcFromName[parts[1]] === undefined) {
                        return next(new errors.UsageError(
                            'unknown service: ' + parts[1]));
                    }
                } else {
                    if (svcFromName[svcOrInst] !== undefined) {
                        svc = svcOrInst;
                    } else {
                        inst = svcOrInst;
                    }
                }
                var ver = null;
                var img = null;
                if (UUID_RE.test(verOrImg)) {
                    img = verOrImg;
                } else {
                    ver = verOrImg;
                }
                var change = {};
                if (inst) {
                    change.instance = inst;
                }
                if (svc) {
                    change.service = svc;
                }
                if (img) {
                    change.image = img;
                }
                if (ver) {
                    change.version = ver;
                }
                changes.push(change);
            }
            self.log.info({changes: changes}, 'getSpecFromArgs');
            next();
        },
        function getSpecFromAllServices(_, next) {
            if (args.length !== 0 || !opts.all) {
                return next();
            }

            // TODO All unresolved services from M3 go here
            var unsupportedInsts = ['binder', 'manatee', 'manta', 'zookeeper'];

            changes = Object.keys(svcFromName).filter(function (name) {
                // Service agents are not supported, so we keep populating
                // unsupportedInsts with the ones we find
                if (svcFromName[name].type === 'agent') {
                    unsupportedInsts.push(name);
                    return false;
                }

                // HEAD-2167 sdcsso has been removed, but the service still
                // exists in some SDC installs (e.g. JPC), so drop update
                // attempts of it.
                if (name === 'sdcsso') {
                    return false;
                }

                return (unsupportedInsts.indexOf(name) === -1);
            }).map(function (name) {
                return { service: name };
            });

            self.log.info({changes: changes}, 'getSpecFromAllServices');
            next();
        },

        function genPlan(_, next) {
            self.sdcadm.genUpdatePlan({
                forceRabbitmq: opts.force_rabbitmq,
                forceSameImage: opts.force_same_image,
                changes: changes,
                justImages: opts.just_images,
                updateAll: opts.all,
                logCb: self.logCb
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            if (plan.procs.length === 0) {
                return next();
            }
            p('');
            p('This update will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, logCb: self.logCb});
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
            if (plan.procs.length === 0) {
                return next();
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                return next();
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                logCb: self.logCb,
                dryRun: opts.dry_run
            }, next);
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                self.log.fatal({err: finishUpErr},
                    'unexpected error finishing up update');
            }
            if (err || finishUpErr) {
                return cb(err || finishUpErr);
            }

            if (plan.procs.length === 0) {
                if (opts.just_images) {
                    p('Up-to-date (all images are imported).');
                } else {
                    p('Up-to-date.');
                }
            } else {
                p('Updated successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
};
CLI.prototype.do_update.aliases = ['up'];
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
        names: ['all', 'a'],
        type: 'bool',
        help: 'Update all instances.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['just-images', 'I'],
        type: 'bool',
        help: 'Just import images. Commonly this is used to preload images '
            + 'before the full upgrade run..'
    },
    {
        names: ['force-rabbitmq'],
        type: 'bool',
        help: 'Forcibly update rabbitmq (which is not updated by default)'
    },
    {
        names: ['force-same-image'],
        type: 'bool',
        help: 'Allow update of an instance(s) even if the target image is '
            + 'the same as the current.'
    }
];
CLI.prototype.do_update.help = (
    'Update SDC services and instances.\n'
    + '\n'
    + 'Usage:\n'
    + '     ...update spec on stdin... | {{name}} update [<options>]\n'
    + '     {{name}} update [<options>] <svc> ...\n'
    + '     {{name}} update [<options>] <svc>@<image> ...\n'
    + '     {{name}} update [<options>] <svc>@<version> ...\n'
    + '     {{name}} update [<options>] <inst> ...\n'
    + '     {{name}} update [<options>] <inst>@<image> ...\n'
    + '     {{name}} update [<options>] <inst>@<version> ...\n'
    + '\n'
    + 'Examples:\n'
    + '     # Update all instances of the cnapi service to the latest\n'
    + '     # available image.\n'
    + '     {{name}} update cnapi\n'
    + '\n'
    + '     TODO: other calling forms\n'
    + '\n'
    + '{{options}}'
);
CLI.prototype.do_update.logToFile = true;

CLI.prototype.do_check_config = function do_check_config(subcmd, opts,
                                                       args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length > 0) {
        return callback(new errors.UsageError('too many args: ' + args));
    }

    this.sdcadm.checkConfig({}, function (err, errs) {
        if (err) {
            callback(err);
        } else {
            if (errs && errs.length) {
                errs.forEach(function (er) {
                    console.error(er);
                });
                callback();
            } else {
                console.info('All good!');
                callback();
            }
        }
    });
};
CLI.prototype.do_check_config.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_check_config.help = (
    'Check sdc config in SAPI versus system reality.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} check-config [<options>]\n'
    + '\n'
    + '{{options}}'
);
CLI.prototype.do_check_config.logToFile = false;


CLI.prototype.do_experimental = experimental.ExperimentalCLI;
CLI.prototype.do_experimental.hidden = true;
CLI.prototype.do_experimental.logToFile = true;



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
     *
     * TODO: change to cmdln v2.0 which has the needed options: .fini(), etc.
     */
    var cli = new CLI();
    cli.main(process.argv, function (err, subcmd) {
        if (err) {
            var code = (err.body ? err.body.code : err.code);
            var showErr = (code !== 'NoCommand');
            var exitStatus = err.exitStatus || 1;

            if (showErr && cli.opts && cli.opts.verbose && cli.log) {
                cli.log.error(
                    {err: err, subcmd: subcmd, exitStatus: exitStatus},
                    'cli exit');
            }

            // If the `err` has no "message" field, then this probably isn't
            // and Error instance. Let's just not print an error message. This
            // can happen if the subcmd passes back `true` or similar to
            // indicate "yes there was an error".
            if (showErr && err.message !== undefined) {
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
