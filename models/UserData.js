const mongoose = require('mongoose');

const userDataSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    currentOdometer: {
        type: Number,
        default: 0
    },
    activeTrip: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
});

module.exports = mongoose.model('UserData', userDataSchema);