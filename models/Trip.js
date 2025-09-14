const mongoose = require('mongoose');

const tripSchema = new mongoose.Schema({
    id: {
        type: Number,
        required: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    purpose: {
        type: String,
        required: true
    },
    startDate: {
        type: String,
        required: true
    },
    startOdometer: {
        type: Number,
        required: true
    },
    startLatitude: {
        type: Number,
        required: true
    },
    startLongitude: {
        type: Number,
        required: true
    },
    startTime: {
        type: Date,
        required: true
    },
    startArea: {
        type: String,
        default: 'Unknown Area'
    },
    active: {
        type: Boolean,
        default: true
    },
    endDate: String,
    endLatitude: Number,
    endLongitude: Number,
    endTime: Date,
    endArea: {
        type: String,
        default: 'Unknown Area'
    },
    gpsDistance: {
        type: Number,
        default: 0
    },
    endOdometer: Number,
    totalDistance: {
        type: Number,
        default: 0
    },
    routePoints: [{
        latitude: Number,
        longitude: Number,
        timestamp: Date,
        accuracy: Number
    }]
});

module.exports = mongoose.model('Trip', tripSchema);