/*
 * Minimal Object Storage Library, (C) 2015 Minio, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var CombinedStream = require('combined-stream') // use MultiStream unless you need lazy append after stream created
var Concat = require('concat-stream')
var Crypto = require('crypto')
var Http = require('http')
var Moment = require('moment')
var ParseXml = require('xml-parser')
var Q = require('q')
var Stream = require('stream')
var Through = require('through')
var Xml = require('xml')
var ParseString = require('xml2js').parseString

class Client {
    constructor(params, transport) {
        "use strict"
        if (transport) {
            this.transport = transport
        } else {
            this.transport = Http
        }
        this.params = params
    }

    // SERIVCE LEVEL CALLS

    makeBucket(bucket, cb) {
        "use strict"

        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            method: 'PUT',
            path: `/${bucket}`
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, response => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb()
        })
        req.end()
    }

    listBuckets() {
        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            path: '/',
            method: 'GET'
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var stream = new Stream.Readable({objectMode: true})
        stream._read = () => {
        }

        var req = this.transport.request(requestParams, (response) => {
            if (response.statusCode !== 200) {
                // TODO work out how to handle errors with stream
                stream.push(parseError(response, (error) => {
                    "use strict";
                    stream.emit('error', error)
                }))
                stream.push(null)
            }
            response.pipe(Concat(errorXml => {
                "use strict";
                var parsedXml = ParseXml(errorXml.toString())
                parsedXml.root.children.forEach(element => {
                    "use strict";
                    if (element.name === 'Buckets') {
                        element.children.forEach(bucketListing => {
                            var bucket = {}
                            bucketListing.children.forEach(prop => {
                                switch (prop.name) {
                                    case "Name":
                                        bucket.name = prop.content
                                        break
                                    case "CreationDate":
                                        bucket.creationDate = prop.content
                                        break
                                }
                            })
                            stream.push(bucket)
                        })
                    }
                })
                stream.push(null)
            }))
        })
        req.end()
        return stream
    }

    bucketExists(bucket, cb) {
        "use strict";

        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            method: 'HEAD',
            path: `/${bucket}`
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, response => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb()
        })
        req.end()
    }

    removeBucket(bucket, cb) {
        "use strict";

        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            method: 'DELETE',
            path: `/${bucket}`
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, response => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb()
        })
        req.end()
    }

    getBucketACL(bucket, cb) {
        "use strict";
        cb('not implemented')
    }

    setBucketACL(bucket, acl, cb) {
        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            method: 'PUT',
            path: `/${bucket}`,
            headers: {
                acl: "",
                'x-amz-acl': acl
            }
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, response => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb()
        })
        req.end()
    }

    dropIncompleteUpload(bucket, key, cb) {
        "use strict";
        dropUploads(this.transport, this.params, bucket, key, cb)
    }

    dropAllIncompleteUploads(bucket, cb) {
        "use strict";
        dropUploads(this.transport, this.params, bucket, null, cb)
    }


    getObject(bucket, object, cb) {
        "use strict";

        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            path: `/${bucket}/${object}`,
            method: 'GET'
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, (response) => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb(null, response.pipe(Through(write, end)))
            function write(chunk) {
                this.queue(chunk)
            }

            function end() {
                this.queue(null)
            }
        })
        req.end()
    }

    putObject(bucket, object, contentType, size, r, cb) {
        "use strict";

        if (contentType == null || contentType == '') {
            contentType = 'aplication/octet-stream'
        }

        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            path: `/${bucket}/${object}`,
            method: 'PUT',
            headers: {
                "Content-Length": size,
                "Content-Type": contentType
            }
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var request = this.transport.request(requestParams, (response) => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            response.pipe(Through(null, end))
            function end() {
                cb()
            }
        })
        r.pipe(request)
    }

    listObjects(bucket, params) {
        "use strict";
        var self = this
        var stream = new Stream.Readable({objectMode: true})
        stream._read = () => {
        }
        var queue = new Stream.Readable({objectMode: true})
        queue._read = () => {
        }
        var prefix = null
        var delimiter = null
        if (params) {
            if (params.prefix) {
                prefix = params.prefix
            }
            if (params.recursive) {
                delimiter = '/'
            }
        }
        queue.push({bucket: bucket, prefix: prefix, marker: null, delimiter: delimiter, maxKeys: 1000})

        queue.pipe(Through(success, end))

        return stream

        function success(currentRequest) {
            getObjectList(self.transport, self.params, currentRequest.bucket, currentRequest.prefix, currentRequest.marker, currentRequest.delimiter, currentRequest.maxKeys, (e, r) => {
                if (e) {
                    stream.emit('error', e)
                    return queue.push(null)
                }
                r.objects.forEach(object => {
                    stream.push(object)
                })
                if (r.isTruncated) {
                    queue.push({
                        bucket: currentRequest.bucket,
                        prefix: currentRequest.prefix,
                        marker: r.marker,
                        delimiter: currentRequest.delimiter,
                        maxKeys: currentRequest.maxKeys
                    })
                } else {
                    queue.push(null)
                }
            })
        }

        function end() {
            stream.push(null)
        }

        function getObjectList(transport, params, bucket, prefix, marker, delimiter, maxKeys, cb) {
            var queries = []
            if (prefix) {
                queries.push(`prefix=${prefix}`)
            }
            if (marker) {
                queries.push(`marker=${marker}`)
            }
            if (delimiter) {
                queries.push(`delimiter=${delimiter}`)
            }
            if (maxKeys) {
                queries.push(`max-keys=${maxKeys}`)
            }
            queries.sort()
            var query = ''
            if (queries.length > 0) {
                query = `?${queries.join('&')}`
            }
            var requestParams = {
                host: params.host,
                port: params.port,
                path: `/${bucket}${query}`,
                method: 'GET'
            }

            signV4(requestParams, '', params.accessKey, params.secretKey)

            var req = transport.request(requestParams, (response) => {
                if (response.statusCode !== 200) {
                    return parseError(response, cb)
                }
                response.pipe(Concat((body) => {
                    var xml = ParseXml(body.toString())
                    var result = {
                        objects: []
                    }
                    xml.root.children.forEach(element => {
                        switch (element.name) {
                            case "IsTruncated":
                                result.isTruncated = element.content === 'true'
                                break
                            case "Contents":
                                var object = {}
                                element.children.forEach(xmlObject => {
                                    switch (xmlObject.name) {
                                        case "Key":
                                            object.name = xmlObject.content
                                            break
                                        case "LastModified":
                                            object.lastModified = xmlObject.content
                                            break
                                        case "Size":
                                            object.size = +xmlObject.content
                                            break
                                        case "ETag":
                                            object.etag = xmlObject.content
                                            break
                                        default:
                                    }
                                })
                                result.objects.push(object)
                                break
                            default:
                        }
                    })
                    cb(null, result)
                }))
            })
            req.end()
        }
    }

    statObject(bucket, object, cb) {
        "use strict";
        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            path: `/${bucket}/${object}`,
            method: 'HEAD'
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, (response) => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            } else {
                var result = {
                    size: +response.headers['content-length'],
                    etag: response.headers['etag'],
                    lastModified: response.headers['last-modified']
                }
                cb(null, result)
            }
        })
        req.end()
    }

    removeObject(bucket, object, cb) {
        "use strict";
        var requestParams = {
            host: this.params.host,
            port: this.params.port,
            path: `/${bucket}/${object}`,
            method: 'DELETE'
        }

        signV4(requestParams, '', this.params.accessKey, this.params.secretKey)

        var req = this.transport.request(requestParams, (response) => {
            if (response.statusCode !== 200) {
                return parseError(response, cb)
            }
            cb()
        })
        req.end()
    }
}

var parseError = (response, cb) => {
    "use strict";
    response.pipe(Concat(errorXml => {
        var parsedXml = ParseXml(errorXml.toString())
        var e = {}
        parsedXml.root.children.forEach(element => {
            if (element.name === 'Status') {
                e.status = element.content
            } else if (element.name === 'Message') {
                e.message = element.content
            } else if (element.name === 'RequestId') {
                e.requestid = element.content
            } else if (element.name === 'Resource') {
                e.resource = element.content
            }
        })
        cb(e)
    }))
}

var getStringToSign = function (canonicalRequestHash, requestDate, region) {
    "use strict";
    var stringToSign = "AWS4-HMAC-SHA256\n"
    stringToSign += requestDate.format('YYYYMMDDTHHmmSS') + 'Z\n'
    stringToSign += `${requestDate.format('YYYYMMDD')}/${region}/s3/aws4_request\n`
    stringToSign += canonicalRequestHash
    return stringToSign
}

var signV4 = (request, dataShaSum256, accessKey, secretKey) => {
    "use strict";

    if (!accessKey || !secretKey) {
        return
    }

    var requestDate = Moment().utc()

    if (!dataShaSum256) {
        dataShaSum256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }

    if (!request.headers) {
        request.headers = {}
    }

    var region = getRegion(request.host)

    request.headers['host'] = request.host
    request.headers['x-amz-date'] = requestDate.format('YYYYMMDDTHHmmSS') + 'Z'
    request.headers['x-amz-content-sha256'] = dataShaSum256

    var canonicalRequestAndSignedHeaders = getCanonicalRequest(request, dataShaSum256)
    var canonicalRequest = canonicalRequestAndSignedHeaders[0]
    var signedHeaders = canonicalRequestAndSignedHeaders[1]
    var hash = Crypto.createHash('sha256')
    hash.update(canonicalRequest)
    var canonicalRequestHash = hash.digest('hex')

    var stringToSign = getStringToSign(canonicalRequestHash, requestDate, region)

    var signingKey = getSigningKey(requestDate, region, secretKey)

    var hmac = Crypto.createHmac('sha256', signingKey)

    hmac.update(stringToSign)
    var signedRequest = hmac.digest('hex').toLowerCase().trim()

    var credentials = `${accessKey}/${requestDate.format('YYYYMMDD')}/${region}/s3/aws4_request`

    request.headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${credentials}, SignedHeaders=${signedHeaders}, Signature=${signedRequest}`

    function getSigningKey(date, region, secretKey) {
        var key = "AWS4" + secretKey
        var dateLine = date.format('YYYYMMDD')

        var hmac1 = Crypto.createHmac('sha256', key).update(dateLine).digest('binary')
        var hmac2 = Crypto.createHmac('sha256', hmac1).update(region).digest('binary')
        var hmac3 = Crypto.createHmac('sha256', hmac2).update("s3").digest('binary')
        return Crypto.createHmac('sha256', hmac3).update("aws4_request").digest('binary')
    }

    function getRegion(host) {
        switch (host) {
            case "s3.amazonaws.com":
                return "us-east-1"
            case "s3-ap-northeast-1.amazonaws.com":
                return "ap-northeast-1"
            case "s3-ap-southeast-1.amazonaws.com":
                return "ap-southeast-1"
            case "s3-ap-southeast-2.amazonaws.com":
                return "ap-southeast-2"
            case "s3-eu-central-1.amazonaws.com":
                return "eu-central-1"
            case "s3-eu-west-1.amazonaws.com":
                return "eu-west-1"
            case "s3-sa-east-1.amazonaws.com":
                return "sa-east-1"
            case "s3-external-1.amazonaws.com":
                return "us-east-1"
            case "s3-us-west-1.amazonaws.com":
                return "us-west-1"
            case "s3-us-west-2.amazonaws.com":
                return "us-west-2"
            default:
                return "milkyway"
        }
    }

    function getCanonicalRequest(request, dataShaSum1) {


        var headerKeys = []
        var headers = []

        for (var key in request.headers) {
            if (request.headers.hasOwnProperty(key)) {
                var value = request.headers[key]
                headers.push(`${key.toLowerCase()}:${value}`)
                headerKeys.push(key.toLowerCase())
            }
        }

        headers.sort()
        headerKeys.sort()

        var signedHeaders = ""
        headerKeys.forEach(element => {
            if (signedHeaders) {
                signedHeaders += ';'
            }
            signedHeaders += element
        })


        var canonicalString = ""
        canonicalString += canonicalString + request.method.toUpperCase() + '\n'
        canonicalString += request.path + '\n'
        if (request.query) {
            canonicalString += request.query + '\n'
        } else {
            canonicalString += '\n'
        }
        headers.forEach(element => {
            canonicalString += element + '\n'
        })
        canonicalString += '\n'
        canonicalString += signedHeaders + '\n'
        canonicalString += dataShaSum1
        return [canonicalString, signedHeaders]
    }
}

var getAllIncompleteUploads = function (transport, params, bucket, object) {
    "use strict";
    var stream = new Stream.Readable({objectMode: true})

    var queue = new Stream.Readable({objectMode: true})

    queue.pipe(Through(success, end))

    queue.on('error', (e) => {
        stream.emit('error', e)
    })

    queue.push({bucket: bucket, object: object, objectMarker: null, uploadIdMarker: null})

    return stream

    function success(currentJob) {
        "use strict";

        listMultipartUploads(transport, params, currentJob.bucket, currentJob.object, currentJob.objectMArker, currentJob.uploadIdMarker, (e, r) => {
            if (response.statusCode !== 200) {
                parseError(response, (e) => {
                    queue.emit('error', e)
                })
                return
            }
            var uploads = []
            // parse xml
            uploads.forEach(upload => {
                stream.push(upload)
            })
            queue.push({bucket: bucket, object: object, objectMarker: objectMarker, uploadIdMarker: uploadIdMarker})
        })

    }

    function end() {
        stream.push()
    }

}

function listMultipartUploads(transport, params, bucket, key, keyMarker, uploadIdMarker, cb) {
    "use strict";
    var queries = []
    if (key) {
        queries.push(`prefix=${key}`)
    }
    if (keyMarker) {
        queries.push(`key-marker=${keyMarker}`)
    }
    if (uploadIdMarker) {
        queries.push(`upload-id-marker=${uploadIdMarker}`)
    }
    queries.push(`max-uploads=1000`)
    queries.sort()
    queries.unshift('uploads')
    var query = ''
    if (queries.length > 0) {
        query = `?${queries.join('&')}`
    }
    var requestParams = {
        host: params.host,
        port: params.port,
        path: `/${bucket}${query}`,
        method: 'GET'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var req = transport.request(requestParams, (response) => {
        if (response.statusCode !== 200) {
            return parseError(response, cb)
        }
        response.pipe(Concat(xml => {
            var parsedXml = ParseXml(xml.toString())
            var result = {
                uploads: [],
                isTruncated: false,
                nextJob: null
            }
            var nextJob = {
                bucket: bucket,
                key: key
            }
            var ignoreTruncated = false
            parsedXml.root.children.forEach(element => {
                switch (element.name) {
                    case "IsTruncated":
                        result.isTruncated = element.content === 'true'
                        break
                    case "NextKeyMarker":
                        nextJob.keyMarker = element.content
                        break
                    case "NextUploadIdMarker":
                        nextJob.uploadIdMarker = element.content
                        break
                    case "Upload":
                        var upload = {
                            bucket: bucket,
                            key: null,
                            uploadId: null,
                        }
                        element.children.forEach(xmlObject => {
                            switch (xmlObject.name) {
                                case "Key":
                                    upload.key = xmlObject.content
                                    break
                                case "UploadId":
                                    upload.uploadId = xmlObject.content
                                    break
                                default:
                            }
                        })
                        if (key) {
                            if (key === upload.key) {
                                result.uploads.push(upload)
                            } else {
                                ignoreTruncated = true
                            }
                        } else {
                            result.uploads.push(upload)
                        }
                        break
                    default:
                }
            })
            if (result.isTruncated && !ignoreTruncated) {
                result.nextJob = nextJob
            } else {
                result.isTruncated = false
            }
            cb(null, result)
        }))
    })
    req.end()
}

var abortMultipartUpload = (transport, params, bucket, key, uploadId, cb) => {
    var requestParams = {
        host: params.host,
        port: params.port,
        path: `/${bucket}/${key}?uploadId=${uploadId}`,
        method: 'DELETE'
    }

    signV4(requestParams, '', params.accessKey, params.secretKey)

    var req = transport.request(requestParams, (response) => {
        "use strict";
        if (response.statusCode !== 200) {
            return parseError(response, cb)
        }
        cb()
    })
    req.end()
}

var dropUploads = (transport, params, bucket, key, cb) => {
    "use strict";
    var self = this

    var listUploadsQueue = new Stream.Readable({objectMode: true})
    listUploadsQueue._read = () => {
    }

    listUploadsQueue.pipe(Through(nextListJob, endListJob))

    listUploadsQueue.on('error', (e) => {
        uploadsToCancelQueue.emit('error', e)
    })

    var uploadsToCancelQueue = new Stream.Readable({objectMode: true})
    uploadsToCancelQueue._read = () => {
    }

    uploadsToCancelQueue.pipe(Through(nextUploadToCancel, endUploadsToCancel))

    uploadsToCancelQueue.on('error', (e) => {
        cb(e)
    })

    listUploadsQueue.push({bucket: bucket, key: key, keyMarker: null, uploadIdMarker: null})


    function nextListJob(job) {
        listMultipartUploads(transport, params, job.bucket, job.key, job.keyMarker, job.uploadIdMarker, (e, result) => {
            if (e) {
                return listUploadsQueue.emit('error', e)
            }
            result.uploads.forEach(element => {
                uploadsToCancelQueue.push(element)
            })
            if (result.isTruncated) {
                listUploadsQueue.push(result.nextJob)
            } else {
                listUploadsQueue.push(null)
            }
        })
    }

    function endListJob() {
        uploadsToCancelQueue.push(null)
    }

    function nextUploadToCancel(upload) {
        abortMultipartUpload(transport, params, upload.bucket, upload.key, upload.uploadId, (e) => {
            // ignore, continue on
        })
    }

    function endUploadsToCancel() {
        cb()
    }
}

var inst = Client
module.exports = inst
