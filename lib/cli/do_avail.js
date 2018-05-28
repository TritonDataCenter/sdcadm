/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The 'sdcadm avail' CLI subcommand.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var tabula = require('tabula');

// --- Internal support stuff which can be shared between
// 'sdcadm avail' and 'sdcadm experimental avail'

function Available(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.cli, 'opts.cli');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.uuid, 'opts.uuid');

    this.log = opts.log;
    this.sdcadm = opts.sdcadm;
    this.progress = opts.progress;
    this.uuid = opts.uuid;
    this.cli = opts.cli;
}

Available.prototype.name = 'avail';

Available.prototype.execute = function cExecute(opts, args, cb) {
    assert.object(opts, 'opts');
    assert.object(args, 'args');
    assert.func(cb, 'cb');

    var self = this;
    /* JSSTYLED */
    var columns = opts.o.trim().split(/\s*,\s*/g);
    /* JSSTYLED */
    var sort = opts.s.trim().split(/\s*,\s*/g);

    // This is always true when nothing is given:
    if (args.length === 0) {
        opts.all = true;
    }

    var changes;
    var plan;

    // override to true list portolan/rabbit
    opts.force_data_path = true;
    opts.force_rabbitmq = true;

    vasync.pipeline({funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, next);
        },
        function setChannel(_, next) {
            // Set or override the default channel if anything is given:
            if (opts.channel) {
                self.sdcadm.updates.channel = opts.channel;
            }
            next();
        },
        function getChangesFromArgs(_, next) {
            self.cli._specFromArgs(opts, args, function (err, chgs) {
                if (err) {
                    return next(err);
                }
                // sdcadm special case
                if (opts.all) {
                    chgs.push({
                        service: 'sdcadm'
                    });
                }
                changes = chgs;
                return next();
            });
        },
        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                forceDataPath: opts.force_data_path,
                forceRabbitmq: opts.force_rabbitmq,
                forceSameImage: false,
                forceBypassMinImage: true,
                changes: changes,
                justImages: false,
                updateAll: opts.all,
                progress: self.progress,
                uuid: self.uuid,
                keepAllImages: opts.all_images,
                noVerbose: true,
                justAvailable: true
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        }
    ]}, function availCb(err) {
        if (err) {
            cb(err);
            return;
        }

        var rows = [];
        var chgs = plan.changes.slice();
        chgs.forEach(function (ch) {
            /*
             * Basically we want to show a row for each candidate image on
             * each "change" -- thats `ch.images` or `ch.image`.
             *
             * However, if *all* instances of a service are on the same image
             * (the typical case), then we want to exclude that image from
             * the `sdcadm avail` listing. `getUpdatePlan` inclues that image
             * only to support `sdcadm up --force-same-image` (an atypical
             * use case).
             *
             * If multiple instances of a service are on *different* images,
             * then we keep all those images in the listing here. Arguably
             * the oldest of these images could be excluded. Meh.
             */
            if (ch.images && ch.images.length > 1) {
                var installedImg;
                if (ch.service.name === 'sdcadm') {
                    installedImg = null;
                } else if (ch.insts) {
                    var imgs = ch.insts.map(function (inst) {
                        return (inst.image);
                    }).sort().filter(function (item, pos, ary) {
                        return (!pos || item !== ary[pos - 1]);
                    });
                    if (imgs.length === 1) {
                        installedImg = imgs[0];
                    }
                } else if (ch.inst && ch.inst.Image) {
                    installedImg = ch.inst.image;
                }

                ch.images.forEach(function (i) {
                    // TOOLS-1237: Do not include current image for all insts:
                    if (installedImg !== i.uuid) {
                        rows.push({
                            service: ch.service.name,
                            image: i.uuid,
                            version: i.name + '@' + i.version
                        });
                    }
                });

            } else {
                var img = ch.image;
                rows.push({
                    service: ch.service.name,
                    image: img.uuid,
                    version: img.name + '@' + img.version
                });
            }
        });


        if (opts.json || opts.jsonstream) {
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 4));
            } else {
                rows.forEach(function (k) {
                    process.stdout.write(JSON.stringify(k) + '\n');
                });
            }
            cb();
            return;
        }

        if (!rows.length) {
            console.log('Up-to-date.');
            cb();
            return;
        }

        tabula(rows, {
            skipHeader: opts.H,
            columns: columns,
            sort: sort
        });
        cb();
    });
};

// --- CLI

function do_avail(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var proc = new Available({
        sdcadm: self.sdcadm,
        log: self.log,
        uuid: self.uuid,
        progress: self.progress,
        cli: self
    });
    opts.experimental = false;
    proc.execute(opts, args, cb);
}

do_avail.aliases = ['available'];
do_avail.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to search for the image(s), even if it' +
            ' is not the default one.'
    },
    {
        names: ['all-images', 'a'],
        type: 'bool',
        help: 'Display all the images available for updates, not only the ' +
            'latest image for each service.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'Show images list as raw JSON. Other options will not apply'
    },
    {
        names: [ 'jsonstream', 'J' ],
        type: 'bool',
        help: 'new-line separated JSON streaming output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        default: 'service,image,version',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        default: 'service,version,image',
        help: 'Sort on the given fields. Default is ' +
            '"service,version,image".',
        helpArg: 'field1,...'
    },
    {
        names: ['exclude', 'x'],
        type: 'arrayOfString',
        help: 'Exclude the given services (only when looking for updates ' +
              'for all services, i.e. no arguments given). Both multiple ' +
              'values (-x svc1 -x svc2) or a single comma separated list ' +
              '(-x svc1,svc2) of service names to be excluded are supported.'
    }
];

do_avail.help = (
    'Display images available for update of SDC services and instances.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} avail(able) [<options>] [<svc>] ...\n' +
    'Examples:\n' +
    '     # Display latest available image for the cnapi service\n' +
    '     {{name}} avail cnapi\n' +
    '\n' +
    '     # Available images for all the services (the default):\n' +
    '     {{name}} avail\n' +
    '\n' +
    '     # TODO: Single instance available/update\n' +
    '     # Display latest available image for binder0 instance\n' +
    '     {{name}} avail binder0\n' +
    '\n' +
    '{{options}}'
);

// --- Experimental CLI

function do_experimental_avail(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var proc = new Available({
        sdcadm: self.sdcadm,
        log: self.log,
        uuid: self.top.uuid,
        progress: self.progress,
        cli: self.top
    });

    opts.experimental = true;
    proc.execute(opts, args, cb);
}


do_experimental_avail.help = do_avail.help;
do_experimental_avail.options = do_avail.options;

// --- exports

module.exports = {
    do_avail: do_avail,
    do_experimental_avail: do_experimental_avail
};
