// POSIX asynchronous I/O
//
// Copyright (c) 2003 Jan Wassenberg
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation; either version 2 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.
//
// Contact info:
//   Jan.Wassenberg@stud.uni-karlsruhe.de
//   http://www.stud.uni-karlsruhe.de/~urkt/

#include <cassert>
#include <cstdlib>
#include <cstdio>

//#include <winsock2.h>
#include "posix.h"
#include "win.h"
#include "misc.h"
#include "types.h"

// Win32 functions require sector aligned transfers.
// updated by aio_open; changes don't affect aio_return
static size_t sector_size = 4096;

// async-capable handles to each lowio file
static HANDLE* aio_hs;
static uint hs_cap;

// information about active transfers (reused)
struct Req
{
	// used to identify this request; != 0 <==> request valid
	aiocb* cb;

	OVERLAPPED ovl;
		// hEvent signals when transfer complete

	// read into a separate align buffer if necessary
	// (note: unaligned writes aren't supported. see aio_rw)
	size_t pad;		// offset from starting sector
	void* buf;		// reused; resize if too small
	size_t buf_size;
};

static const int MAX_REQS = 4;
static Req reqs[MAX_REQS];

// TODO: use pthread mutex
static HANDLE open_mutex = INVALID_HANDLE_VALUE;
static HANDLE reqs_mutex = INVALID_HANDLE_VALUE;
#define LOCK(what)\
{\
if(what##_mutex == INVALID_HANDLE_VALUE)\
	what##_mutex = CreateMutex(0,0,"aio_"#what);\
WaitForSingleObject(what##_mutex, INFINITE);\
}
#define UNLOCK(what) ReleaseMutex(what##_mutex);


// get async capable handle to file <fd>
// current implementation: open both versions of the file on open()
//   wastes 1 handle/file, but we don't have to remember the filename/mode
static HANDLE aio_h(int fd)
{
	if((unsigned)fd >= hs_cap)
		return INVALID_HANDLE_VALUE;

	return aio_hs[fd];
}


// find request slot currently in use by cb
// cb = 0 => search for empty slot
static Req* find_req(const aiocb* cb)
{
	Req* r = reqs;
	for(int i = 0; i < MAX_REQS; i++, r++)
		if(r->cb == cb)
			return r;

	return 0;
}


static void cleanup(void)
{
	int i;

	// close files
	for(i = 0; i < (int)hs_cap; i++)
	{
		HANDLE h = aio_h(i);
		if(h != INVALID_HANDLE_VALUE)
			CloseHandle(h);
	}
	free(aio_hs);
	aio_hs = 0;
	hs_cap = 0;

	// free requests
	Req* r = reqs;
	for(i = 0; i < MAX_REQS; i++, r++)
	{
		r->cb = 0;

		CloseHandle(r->ovl.hEvent);
		r->ovl.hEvent = INVALID_HANDLE_VALUE;

		free(r->buf);
		r->buf = 0;
	}

	CloseHandle(open_mutex);
	open_mutex = INVALID_HANDLE_VALUE;
	if(reqs_mutex != INVALID_HANDLE_VALUE)	// happens if not initialized, i.e. aio_rw wasn't called
		CloseHandle(reqs_mutex);
	reqs_mutex = INVALID_HANDLE_VALUE;
}

// called by aio_open and aio_open_winhandle
static void init()
{
	ONCE(
		for(int i = 0; i < MAX_REQS; i++)
		{
			reqs[i].ovl.hEvent = CreateEvent(0,1,0,0);	// manual reset
			//printf("Req %p [%d]: hEvent %x\n", reqs+i, i, reqs[i].ovl.hEvent);
		}

		atexit(cleanup);
	)
}


int aio_close(int fd)
{
	HANDLE h = aio_h(fd);
	if(h == INVALID_HANDLE_VALUE)	// out of bounds or already closed
		return -1;

	CloseHandle(h);
	aio_hs[fd] = INVALID_HANDLE_VALUE;
	return 0;
}

//NOTE: Requires that the "open" lock is held
int alloc_handle_entry(int fd)
{
	// alloc aio_hs entry
	if((unsigned)fd >= hs_cap)
	{
		uint hs_cap2 = (uint)round_up(fd+8, 8);
		HANDLE* aio_hs2 = (HANDLE*)realloc(aio_hs, hs_cap2*sizeof(HANDLE));
		if(!aio_hs2)
			return -1;

        for(uint i = hs_cap; i < hs_cap2; i++)
			aio_hs2[i] = INVALID_HANDLE_VALUE;
		aio_hs = aio_hs2;
		hs_cap = hs_cap2;
	}
	return 0;
}

// fd is already opened in async/overlapped mode; add to required internal structures
int aio_open_winhandle(HANDLE fd)
{
	init();

	LOCK(open)

	if (alloc_handle_entry(HANDLE2INT(fd)) == -1)
	{
		UNLOCK(open)
		return -1;
	}

	aio_hs[HANDLE2INT(fd)]=fd;

	UNLOCK(open)
	return 0;
}

// open fn in async mode; associate with fd (retrieve via aio_h(fd))
int aio_open(const char* fn, int mode, int fd)
{
	init();

LOCK(open)

	if (alloc_handle_entry(fd) == -1)
		return -1;

UNLOCK(open)

	// interpret mode
	u32 access = GENERIC_READ;	// assume O_RDONLY
	u32 share = 0;
	if(mode & O_WRONLY)
		access = GENERIC_WRITE;
	else if(mode & O_RDWR)
		access = GENERIC_READ|GENERIC_WRITE;
	else
		share = FILE_SHARE_READ;
	u32 create = OPEN_EXISTING;
	if(mode & O_CREAT)
		create = (mode & O_EXCL)? CREATE_NEW : CREATE_ALWAYS;
	u32 flags = FILE_FLAG_OVERLAPPED|FILE_FLAG_NO_BUFFERING|FILE_FLAG_SEQUENTIAL_SCAN;

	// open file, store in aio_hs array
	aio_hs[fd] = CreateFile(fn, access, share, 0, create, flags, 0);
	if(aio_hs[fd] == INVALID_HANDLE_VALUE)
		return -1;

	// check drive's sector size (Win32 requires alignment)
	char path[PATH_MAX];
	realpath(fn, path);
	path[3] = 0;		// cut off after ?:\\ 
	u32 spc, nfc, tnc;	// don't need these
	u32 sector_size2;
	GetDiskFreeSpace(path, &spc, &sector_size2, &nfc, &tnc);

LOCK(open)

	if(sector_size < sector_size2)
		sector_size = sector_size2;

UNLOCK(open)

	return 0;
}


// called by aio_read, aio_write, and lio_listio
// cb->aio_lio_opcode specifies desired operation
static int aio_rw(struct aiocb* cb)
{
	if(!cb)
		return -1;
	if(cb->aio_lio_opcode == LIO_NOP)
		return 0;

	HANDLE h = aio_h(cb->aio_fildes);
	if(h == INVALID_HANDLE_VALUE)
	{
		printf("Invalid handle\n");
		return -1;
	}

LOCK(reqs)

	// find free request slot
	Req* r = find_req(0);
	if(!r)
	{
		UNLOCK(reqs)
		printf("No Req\n");
		return -1;
	}
	r->cb = cb;

UNLOCK(reqs)

	size_t ofs = 0;
	size_t size = cb->aio_nbytes;
	void* buf = cb->aio_buf;

#define SOL_SOCKET 0xffff
#define SO_TYPE 0x1008

	unsigned long opt = 0;
	socklen_t optlen = sizeof(opt);
	if (getsockopt((int)h, SOL_SOCKET, SO_TYPE, &opt, &optlen) != -1)
//		||	(WSAGetLastError() != WSAENOTSOCK))
		cb->aio_offset = 0;
	else
	{
		// align
		r->pad = cb->aio_offset % sector_size;		// offset to start of sector
		ofs = cb->aio_offset - r->pad;
		size += r->pad + sector_size-1;
		size &= sector_size-1;	// align (sector_size = 2**n)

		if(r->pad || (uintptr_t)buf % sector_size)
		{
			// current align buffer is too small - resize
			if(r->buf_size < size)
			{
				void* buf2 = realloc(r->buf, size);
				if(!buf2)
					return -1;
				r->buf = buf2;
				r->buf_size = size;
			}

			// unaligned writes are not supported -
			// we'd have to read padding, then write our data. ugh.
			if(cb->aio_lio_opcode == LIO_WRITE)
			{
				return -1;
			}

			buf = r->buf;
		}
	}

#if _MSC_VER >= 1300
	r->ovl.Pointer = (void*)ofs;
#else
	r->ovl.Offset = ofs;
#endif

	DWORD size32 = (DWORD)(size & 0xffffffff);
	u32 status = (cb->aio_lio_opcode == LIO_READ)?
		ReadFile(h, buf, size32, 0, &r->ovl) : WriteFile(h, buf, size32, 0, &r->ovl);

	if(status || GetLastError() == ERROR_IO_PENDING)
		return 0;
	return -1;
}


int aio_read(struct aiocb* cb)
{
	cb->aio_lio_opcode = LIO_READ;
	return aio_rw(cb);
}


int aio_write(struct aiocb* cb)
{
	cb->aio_lio_opcode = LIO_WRITE;
	return aio_rw(cb);
}


int lio_listio(int mode, struct aiocb* const cbs[], int n, struct sigevent* se)
{
	UNUSED(se)

	for(int i = 0; i < n; i++)
		aio_rw(cbs[i]);		// aio_rw checks for 0 param

	if(mode == LIO_WAIT)
		aio_suspend(cbs, n, 0);

	return 0;
}


// return status of transfer
int aio_error(const struct aiocb* cb)
{
	Req* const r = find_req(cb);
	if(!r)
		return -1;

	switch(r->ovl.Internal)	// I/O status
	{
	case 0:
		return 0;
	case STATUS_PENDING:
		return -EINPROGRESS;

	// TODO: errors
	default:
		return -1;
	}
}


// get bytes transferred. call exactly once for each op.
ssize_t aio_return(struct aiocb* cb)
{
	Req* const r = find_req(cb);
	if(!r)
		return -1;

	assert(r->ovl.Internal == 0 && "aio_return with transfer in progress");

	// read wasn't aligned - need to copy to user's buffer
	const size_t _buf = (char*)cb->aio_buf - (char*)0;
	if(r->pad || _buf % sector_size)
		memcpy(cb->aio_buf, (u8*)r->buf + r->pad, cb->aio_nbytes);

	// free this request slot
	r->cb = 0;

	return (ssize_t)cb->aio_nbytes;
}


int aio_cancel(int fd, struct aiocb* cb)
{
	UNUSED(cb)

	const HANDLE h = aio_h(fd);
	if(h == INVALID_HANDLE_VALUE)
		return -1;

	// Win32 limitation: can't cancel single transfers
	CancelIo(h);
	return AIO_CANCELED;
}


int aio_fsync(int, struct aiocb*)
{
	return -1;
}


int aio_suspend(const struct aiocb* const cbs[], int n, const struct timespec* ts)
{
	if(n <= 0 || n > MAXIMUM_WAIT_OBJECTS)
		return -1;

	int cnt = 0;	// actual number of valid cbs
	HANDLE* hs = (HANDLE*)malloc(n*sizeof(HANDLE));
	if(!hs)
		return -1;
	for(int i = 0; i < n; i++)
	{
		// ignore NULL list entries
		if(!cbs[i])
			continue;

		Req* r = find_req(cbs[i]);
		if(r)
		{
			if(r->ovl.Internal == STATUS_PENDING)
				hs[cnt++] = r->ovl.hEvent;
		}
	}

	// no valid, pending transfers - done
	if(!cnt)
		return 0;

	// timeout: convert timespec to ms (NULL ptr -> no timeout)
	u32 timeout = INFINITE;
	if(ts)
		timeout = ts->tv_sec*1000 + ts->tv_nsec/1000000;

	u32 status = WaitForMultipleObjects(cnt, hs, 0, timeout);

	free(hs);

	if(status == WAIT_TIMEOUT)
	{
		//errno = -EAGAIN;
		return -1;
	}
	else if(status == WAIT_FAILED)
		return -1;
	return 0;
}
