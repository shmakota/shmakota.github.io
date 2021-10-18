/*************************************************************************/
/*  audio.worklet.js                                                     */
/*************************************************************************/
/*                       This file is part of:                           */
/*                           GODOT ENGINE                                */
/*                      https://godotengine.org                          */
/*************************************************************************/
/* Copyright (c) 2007-2021 Juan Linietsky, Ariel Manzur.                 */
/* Copyright (c) 2014-2021 Godot Engine contributors (cf. AUTHORS.md).   */
/*                                                                       */
/* Permission is hereby granted, free of charge, to any person obtaining */
/* a copy of this software and associated documentation files (the       */
/* "Software"), to deal in the Software without restriction, including   */
/* without limitation the rights to use, copy, modify, merge, publish,   */
/* distribute, sublicense, and/or sell copies of the Software, and to    */
/* permit persons to whom the Software is furnished to do so, subject to */
/* the following conditions:                                             */
/*                                                                       */
/* The above copyright notice and this permission notice shall be        */
/* included in all copies or substantial portions of the Software.       */
/*                                                                       */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,       */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF    */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.*/
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY  */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,  */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE     */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                */
/*************************************************************************/

class RingBuffer {
	constructor(p_buffer, p_state) {
		this.buffer = p_buffer;
		this.avail = p_state;
		this.rpos = 0;
		this.wpos = 0;
	}

	data_left() {
		return Atomics.load(this.avail, 0);
	}

	space_left() {
		return this.buffer.length - this.data_left();
	}

	read(output) {
		const size = this.buffer.length;
		let from = 0;
		let to_write = output.length;
		if (this.rpos + to_write > size) {
			const high = size - this.rpos;
			output.set(this.buffer.subarray(this.rpos, size));
			from = high;
			to_write -= high;
			this.rpos = 0;
		}
		output.set(this.buffer.subarray(this.rpos, this.rpos + to_write), from);
		this.rpos += to_write;
		Atomics.add(this.avail, 0, -output.length);
		Atomics.notify(this.avail, 0);
	}

	write(p_buffer) {
		const to_write = p_buffer.length;
		const mw = this.buffer.length - this.wpos;
		if (mw >= to_write) {
			this.buffer.set(p_buffer, this.wpos);
		} else {
			const high = p_buffer.subarray(0, to_write - mw);
			const low = p_buffer.subarray(to_write - mw);
			this.buffer.set(high, this.wpos);
			this.buffer.set(low);
		}
		let diff = to_write;
		if (this.wpos + diff >= this.buffer.length) {
			diff -= this.buffer.length;
		}
		this.wpos += diff;
		Atomics.add(this.avail, 0, to_write);
		Atomics.notify(this.avail, 0);
	}
}

class GodotProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.running = true;
		this.lock = null;
		this.notifier = null;
		this.output = null;
		this.output_buffer = new Float32Array();
		this.input = null;
		this.input_buffer = new Float32Array();
		this.port.onmessage = (event) => {
			const cmd = event.data['cmd'];
			const data = event.data['data'];
			this.parse_message(cmd, data);
		};
	}

	process_notify() {
		Atomics.add(this.notifier, 0, 1);
		Atomics.notify(this.notifier, 0);
	}

	parse_message(p_cmd, p_data) {
		if (p_cmd === 'start' && p_data) {
			const state = p