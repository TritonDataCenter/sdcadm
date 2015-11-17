/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var errors = require('../errors');
var common = require('../common');

var fs = require('fs');

/*
 * The 'sdcadm self-update' CLI subcommand.
 */
function do_self_update(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var image = (opts.latest) ? 'latest' : args.shift();

    if (!image) {
        cb(new errors.UsageError(
        'Please provide an image UUID or use `sdcadm self-update --latest`\n' +
        'in order to update to the latest available image.'));
    }

    if (image === 'help') {
        cb(new errors.UsageError(
        'Please use `sdcadm help self-update` instead'));
    }


    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    var completion = this.bashCompletion();

    self.sdcadm.selfUpdate({
        progress: this.progress,
        allowMajorUpdate: opts.allow_major_update,
        dryRun: opts.dry_run,
        image: image
    }, function (err) {
        if (err) {
            return cb(err);
        }
        self.progress('Generating updated sdcadm bash completion file');
        fs.writeFile('/opt/smartdc/sdcadm/etc/sdcadm.completion',
                    completion, 'utf8', function (err2) {
            if (err2) {
                return cb(err2);
            }

            fs.readFile('/root/.bashrc', 'utf8', function (err3, data) {
                if (err3) {
                    return cb(err3);
                }

                if (data.indexOf('sdcadm.completion') === -1) {
                    self.progress('Adding sdcadm completion to ~/.bashrc');
                    fs.appendFile('/root/.bashrc',
                            'source /opt/smartdc/sdcadm/etc/sdcadm.completion',
                            'utf8', function (err4) {
                        if (err4) {
                            return cb(err4);
                        }
                        return cb();
                    });
                } else {
                    return cb();
                }
            });
        });
    });
}

do_self_update.options = [
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
        help: 'Allow a major version update to sdcadm. By default major ' +
               'updates are skipped (to avoid accidental backward ' +
               'compatibility breakage).'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is ' +
            'not the default one.'
    },
    {
        names: ['latest'],
        type: 'bool',
        help: 'Get the latest available image.'
    }
];

do_self_update.help = (
    'Update "sdcadm" itself.\n' +
    '\n' +
    'Usage:\n' +
    '     # Update to the given image UUID:\n' +
    '     {{name}} self-update IMAGE_UUID [<options>]\n' +
    '     # Update to the latest available image:\n' +
    '     {{name}} self-update --latest [<options>]\n' +
    '\n' +
    '{{options}}'
);

do_self_update.logToFile = true;

// --- exports

module.exports = {
    do_self_update: do_self_update
};
