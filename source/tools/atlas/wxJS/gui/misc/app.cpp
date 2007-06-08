#include "precompiled.h"

/*
 * wxJavaScript - app.cpp
 *
 * Copyright (c) 2002-2007 Franky Braem and the wxJavaScript project
 *
 * Project Info: http://www.wxjavascript.net or http://wxjs.sourceforge.net
 *
 * This library is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301,
 * USA.
 *
 * $Id: app.cpp 716 2007-05-20 17:57:22Z fbraem $
 */
// app.cpp

#include <wx/wxprec.h>
#ifndef WX_PRECOMP
	#include <wx/wx.h>
#endif
#ifdef __WXMSW__
	#include <wx/msw/private.h>
#endif
#include <wx/cmdline.h>

#include "../../common/main.h"
#include "../../common/jsutil.h"

#include "../control/window.h"

#include "app.h"

using namespace wxjs;
using namespace wxjs::gui;

// IMPLEMENT_APP_NO_MAIN(App)

/***
 * <file>misc/app</file>
 * <module>gui</module>
 * <class name="wxApp">
 *	wxApp represents the GUI application. wxJS instantiates
 *  an object of this type and stores it in the global
 *  variable wxTheApp. The script is responsible for calling
 *  @wxApp#mainLoop. Before the main loop is entered,
 *  the function that is put in @wxApp#onInit is called. This
 *  function must create a top-level window, make it visible
 *  and return true. Otherwise the main loop is immediately
 *  ended.<br /><br />
 *  <b>Remark:</b>When the application is dialog based
 *  and the dialog is a modal dialog, the onInit function
 *  must return false.
 * </class>
 */
WXJS_INIT_CLASS(App, "wxApp", 0)

App::~App()
{
}

/***
 * <properties>
 *	<property name="appName" type="String">Get/Set the application name</property>
 *  <property name="className" type="String">Get/Set the classname</property>
 *  <property name="topWindow" type="@wxWindow">Get/Set the top window of your application.</property>
 *  <property name="vendorName" type="String">Get/Set the vendor name</property>
 * </properties>	
 */
WXJS_BEGIN_PROPERTY_MAP(App)
  WXJS_PROPERTY(P_APPLICATION_NAME, "appName")
  WXJS_PROPERTY(P_CLASS_NAME, "className")
  WXJS_PROPERTY(P_VENDOR_NAME, "vendorName")
  WXJS_PROPERTY(P_TOP_WINDOW, "topWindow")
WXJS_END_PROPERTY_MAP()

void App::DestroyTopWindows()
{
    while ( !wxTopLevelWindows.empty() )
    {
        // do not use Destroy() here as it only puts the TLW in pending list
        // but we want to delete them now
        delete wxTopLevelWindows.GetFirst()->GetData();
    }
}

bool App::GetProperty(wxApp *p, JSContext *cx, JSObject *obj, int id, jsval *vp)
{
	switch (id) 
	{
	case P_APPLICATION_NAME:
		*vp = ToJS(cx, p->GetAppName());
		break;
	case P_CLASS_NAME:
		*vp = ToJS(cx, p->GetClassName());
		break;
	case P_VENDOR_NAME:
		*vp = ToJS(cx, p->GetVendorName());
		break;
	case P_TOP_WINDOW:
		{
		  wxWindow *win = p->GetTopWindow();
          if ( win != NULL )
          {
            JavaScriptClientData *data
              = dynamic_cast<JavaScriptClientData*>(win->GetClientObject());
            if ( data != NULL )
    	      *vp = OBJECT_TO_JSVAL(data->GetObject());
          }
          break;
		}
/*		case P_USE_BEST_VISUAL:
		*vp = BOOLEAN_TO_JSVAL(p->GetUseBestVisual());
		break;
*/	}

	return true;
}

bool App::SetProperty(wxApp *p, JSContext *cx, JSObject *obj, int id, jsval *vp)
{
	switch (id) 
	{
	case P_APPLICATION_NAME:
		{
			wxString name;
			FromJS(cx, *vp, name);
			p->SetAppName(name);
			break;
		}
	case P_CLASS_NAME:
	    {
		    wxString name;
		    FromJS(cx, *vp, name);
		    p->SetClassName(name);
		    break;
	    }
	case P_VENDOR_NAME:
		{
			wxString name;
			FromJS(cx, *vp, name);
			p->SetVendorName(name);
			break;
		}
	case P_TOP_WINDOW:
        {
            wxWindow *win = Window::GetPrivate(cx, *vp);
			if ( win != NULL )
				p->SetTopWindow(win);
    		break;
		}
	}

	return true;
}

WXJS_BEGIN_METHOD_MAP(App)
  WXJS_METHOD("mainLoop", mainLoop, 0)
WXJS_END_METHOD_MAP()

/***
 * <method name="mainLoop">
 *  <function />
 *  <desc>
 *	 Enters the main loop (meaning it starts your application). Before the application
 *	 is started it will call the function you've set in the @wxApp#onInit event.
 *	 You don't have to use mainLoop for executing a script. You only need this function
 *	 when you want to block the execution of the script (i.e. when not using
 *   modal dialogs).
 *  </desc>
 * </method>
 */
JSBool App::mainLoop(JSContext *cx,
                     JSObject *obj,
                     uintN argc,
                     jsval *argv,
                     jsval *rval)
{
	wxApp *p = GetPrivate(cx, obj);

	p->OnRun();

	return JS_TRUE;				
}

int App::MainLoop()
{
	int retval = 0;

	SetExitOnFrameDelete(TRUE);
	if ( CallOnInit() )
	{
		bool initialized = (wxTopLevelWindows.GetCount() != 0);
		if ( initialized )
		{
			if ( GetTopWindow()->IsShown() )
			{
				retval = wxApp::MainLoop(); 
			}
		}
	}
	
	DestroyTopWindows();
	return retval;
}

bool App::OnInit()
{
  JavaScriptClientData *data
    = dynamic_cast<JavaScriptClientData*>(GetClientObject());
  if ( data == NULL )
    return false;

	jsval fval;
	if ( GetFunctionProperty(data->GetContext(), data->GetObject(), 
                             "onInit", &fval) == JS_TRUE )
	{
		jsval rval;
		if ( JS_CallFunctionValue(data->GetContext(), data->GetObject(), 
                                  fval, 0, NULL, &rval) == JS_TRUE )
		{
			if ( JSVAL_IS_BOOLEAN(rval) )
			{
				if ( JSVAL_TO_BOOLEAN(rval) == JS_TRUE )
				{
					return true;
				}
				return false;				
			}
		}
		else
		{
			JS_ReportPendingException(data->GetContext());
			return false;
		}
	}

	return true;
}

int App::OnExit()
{
  JavaScriptClientData *data
    = dynamic_cast<JavaScriptClientData*>(GetClientObject());
  if ( data == NULL )
    return false;

  jsval fval;
  if ( GetFunctionProperty(data->GetContext(), data->GetObject(), 
                           "onExit", &fval) == JS_TRUE )
  {
	jsval rval;
    JSBool result = JS_CallFunctionValue(data->GetContext(), data->GetObject(), 
                                         fval, 0, NULL, &rval);
	if ( result == JS_TRUE )
    {
	  if ( rval == JSVAL_VOID )
		  return 0;

	  int rc;
      if ( FromJS(data->GetContext(), rval, rc) )
      {
		  return rc;
      }
      else
      {
        if ( JS_IsExceptionPending(data->GetContext()) )
        {
          JS_ReportPendingException(data->GetContext());
        }
      }
    }
  }

  return 0;
}

/***
 * <events>
 *  <event name="onInit">
 *	 Called when the application needs to be initialized. Set a function
 *	 that returns a boolean. When it returns false the application will stop (onExit
 *   isn't called!).
 *	 <b>Remark:</b>When your application is dialog based and the dialog is modal,
 *	    you must return false, otherwise the application keeps running. 
 *  </event>
 *  <event name="onExit">
 *   This function is executed when the application exits.
 *   The function doesn't get any parameters and must return an Integer.
 *  </event>
 * </events>
 */
