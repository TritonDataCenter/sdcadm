/**
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Error classes that sdcadm may produce.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var assert = require('assert-plus');
var verror = require('verror'),
    WError = verror.WError,
    VError = verror.VError;



// ---- internal support stuff

function _indent(s, indent) {
    if (!indent) {
        indent = '    ';
    }
    var lines = s.split(/\r?\n/g);
    return indent + lines.join('\n' + indent);
}



// ---- error classes

/**
 * Base sdcadm error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string).
 */
function SdcAdmError(options) {
    assert.object(options, 'options');
    assert.string(options.message, 'options.message');
    assert.string(options.code, 'options.code');
    assert.optionalObject(options.cause, 'options.cause');
    assert.optionalNumber(options.statusCode, 'options.statusCode');
    var self = this;

    var args = [];
    if (options.cause) {
        args.push(options.cause);
    }
    args.push('%s');
    args.push(options.message);
    WError.apply(this, args);

    var extra = Object.keys(options).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(SdcAdmError, WError);

function InternalError(options) {
    assert.object(options, 'options');
    assert.optionalObject(options.cause, 'options.cause');
    assert.string(options.message, 'options.message');
    options.code = 'InternalError';
    options.exitStatus = 1;
    SdcAdmError.call(this, options);
}
util.inherits(InternalError, SdcAdmError);

function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 2
    });
}
util.inherits(UsageError, SdcAdmError);

function UpdateError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Update',
        exitStatus: 2
    });
}
util.inherits(UpdateError, SdcAdmError);

function ValidationError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcAdmError.call(this, {
        cause: cause,
        message: message,
        code: 'Validation',
        exitStatus: 2
    });
}
util.inherits(ValidationError, SdcAdmError);

/**
 * An error to wrap around node-sdc-clients API errors.
 * This *prefers* they are following:
 *      https://mo.joyent.com/docs/eng/master/#error-handling
 * but we have enough exceptions, even in APIs like IMGAPI that try hard
 * that we need to be defensive.
 */
function SDCClientError(cause, clientName) {
    assert.object(cause, 'cause');
    assert.optionalObject(cause.body, 'cause.body');
    var body = cause.body || {message: cause.message || cause.toString()};
    assert.optionalString(body.code, 'cause.body.code');
    assert.optionalString(body.message, 'cause.body.message');
    assert.string(clientName, 'clientName');

    var codeExtra = (body.code ? ' ('+body.code+')' : '');
    var msg = body.message || cause.message || cause.toString();
    if (body.errors) {
        body.errors.forEach(function (e) {
            msg += format('\n    %s: %s', e.field, e.code);
            if (e.message) {
                msg += ': ' + e.message;
            }
        });
    }
    SdcAdmError.call(this, {
        cause: cause,
        message: format('%s client error%s: %s', clientName, codeExtra, msg),
        code: 'SDCClient',
        exitStatus: 1
    });
}
SDCClientError.description = 'An error from an API client.';
util.inherits(SDCClientError, SdcAdmError);

/**
 * Multiple errors in a group.
 */
function MultiError(errs) {
    assert.arrayOfObject(errs, 'errs');
    var lines = [format('multiple (%d) errors', errs.length)];
    for (var i = 0; i < errs.length; i++) {
        var err = errs[i];
        lines.push(format('    error (%s): %s', err.code, err.message));
    }
    SdcAdmError.call(this, {
        cause: errs[0],
        message: lines.join('\n'),
        code: 'MultiError',
        exitStatus: 1
    });
}
MultiError.description = 'Multiple errors.';
util.inherits(MultiError, SdcAdmError);



// ---- exports


/**
 * Use this as a convenience shortcut to wrap a callback to a node-sdc-client.
 * Any returned error will be wrapped in `SDCClientError`.
 */
function sdcClientErrWrap(cb, clientName) {
    return function sdcClientCb() {
        if (arguments[0]) {
            arguments[0] = new SDCClientError(arguments[0], clientName);
        }
        cb.apply(null, arguments);
    };
}

module.exports = {
    SdcAdmError: SdcAdmError,
    InternalError: InternalError,
    UsageError: UsageError,
    UpdateError: UpdateError,
    ValidationError: ValidationError,
    SDCClientError: SDCClientError,
    MultiError: MultiError,

    sdcClientErrWrap: sdcClientErrWrap
};
// vim: set softtabstop=4 shiftwidth=4:
