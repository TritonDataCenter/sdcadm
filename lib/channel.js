/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * 'sdcadm channel ...' CLI commands.
 *
 * sdcadm commands for operations with update channels: provide a list
 * of available update channels, set/update the preferred channel instead
 * of fall back into remote updates server default.
 */

var util = require('util');
var tabula = require('tabula');

var cmdln = require('cmdln');
var Cmdln = cmdln.Cmdln;

var errors = require('./errors');

// --- Channel CLI class

function ChannelCLI(top) {
    this.top = top;
    Cmdln.call(this, {
        name: 'sdcadm channel',
        desc: 'sdcadm commands for operations with update channels.\n' +
              '\n' +
              'Provide a list of available update channels and set/update \n' +
              'the preferred update channel.',
        helpOpts: {
            minHelpCol: 24 /* line up with option help */
        }
    });
}
util.inherits(ChannelCLI, Cmdln);

ChannelCLI.prototype.init = function init(_opts, _args, _callback) {
    this.sdcadm = this.top.sdcadm;
    this.progress = this.top.progress;
    this.log = this.top.log;

    Cmdln.prototype.init.apply(this, arguments);
};


ChannelCLI.prototype.do_list =
function do_list(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var progress = self.progress;
    var app = self.sdcadm.sdc;

    self.sdcadm.updates.listChannels({}, function (err, channels) {
        if (err) {
            progress('Error trying to retrieve update channels');
            var e = new errors.SDCClientError(err, 'imgapi');
            cb(e);
            return;
        }

        if (app.metadata.update_channel) {
            channels = channels.map(function (c) {
                if (c.name === app.metadata.update_channel) {
                    c['default'] = true;
                } else {
                    delete c['default'];
                }
                return c;
            });
        } else {
            channels = channels.map(function (c) {
                if (c['default']) {
                    c.remote = true;
                }
                return c;
            });
        }

        if (opts.json) {
            console.log(JSON.stringify(channels, null, 4));
            cb();
            return;
        }

        channels = channels.map(function (c) {
            if (c['default'] && c.remote) {
                delete c.remote;
                c['default'] = 'true (remote)';
            }
            return c;
        });


        var validFieldsMap = {};
        channels.forEach(function (v) {
            var k;
            for (k in v) {
                validFieldsMap[k] = true;
            }
        });

        tabula(channels, {
            skipHeader: opts.H,
            columns: ['name', 'default', 'description'],
            validFields: Object.keys(validFieldsMap)
        });

        cb();
    });
};

ChannelCLI.prototype.do_list.help = (
    'Provides a list of update channels available.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} list\n' +
    '\n' +
    '{{options}}'
);

ChannelCLI.prototype.do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON Output'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Omit table header row.'
    }
];


ChannelCLI.prototype.do_set =
function do_set(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    if (!args.length) {
        cb(new errors.UsageError('must specify a channel name'));
        return;
    }

    var channel = args.shift();
    var progress = self.progress;
    var app = self.sdcadm.sdc;

    self.sdcadm.updates.listChannels({}, function (err, channels) {
        if (err) {
            progress('Error trying to retrieve update channels');
            cb(new errors.SDCClientError(err, 'imgapi'));
            return;
        }

        var names = channels.map(function (c) {
            return (c.name);
        });

        if (names.indexOf(channel) === -1) {
            progress('Must specify a valid channel: %j', channels);
            cb(new errors.UsageError('Invalid channel name'));
            return;
        }

        self.sdcadm.sapi.updateApplication(app.uuid, {
            metadata: {
                update_channel: channel
            }
        }, function updateAppCb(updateErr, _svc) {
            if (updateErr) {
                cb(new errors.SDCClientError(updateErr, 'sapi'));
                return;
            }
            progress('Update channel has been successfully set to: \'%s\'',
                    channel);
            cb();
        });
    });
};

ChannelCLI.prototype.do_set.help = (
    'Set the default update channel.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} set CHANNEL_NAME\n' +
    '\n' +
    '{{options}}'
);

ChannelCLI.prototype.do_set.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];


ChannelCLI.prototype.do_unset =
function do_unset(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var progress = self.progress;
    var app = self.sdcadm.sdc;

    self.sdcadm.sapi.updateApplication(app.uuid, {
        metadata: {
            update_channel: app.metadata.update_channel
        },
        action: 'delete'
    }, function updateAppCb(err, _svc) {
        if (err) {
            cb(new errors.SDCClientError(err, 'sapi'));
            return;
        }
        progress('Update channel has been successfully unset');
        cb();
    });
};

ChannelCLI.prototype.do_unset.help = (
    'Unset the default update channel (use remote server default).\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} unset\n' +
    '\n' +
    '{{options}}'
);

ChannelCLI.prototype.do_unset.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

ChannelCLI.prototype.do_unset.hidden = true;

ChannelCLI.prototype.do_get = function do_get(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var progress = self.progress;

    self.sdcadm.getDefaultChannel(function (err, channel) {
        if (err) {
            progress('Error trying to retrieve update channels');
        } else {
            progress(channel);
        }
        return cb();
    });
};

ChannelCLI.prototype.do_get.help = (
    'Get the default update channel.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} get\n' +
    '\n' +
    '{{options}}'
);

ChannelCLI.prototype.do_get.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];

// --- exports

module.exports = {
    ChannelCLI: ChannelCLI
};
